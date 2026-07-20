import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  listManagedSections,
  readFileIfExists,
  sectionContent,
  sha256,
  toPosixPath,
} from "@agentpack/filesystem";
import {
  type AdapterContext,
  type ArtifactRoot,
  type CanonicalPack,
  type CapabilityFinding,
  type CapabilityReport,
  type DetectionContext,
  type GeneratedArtifact,
  type ImportContext,
  type ImportedConfiguration,
  type ImportedInstruction,
  type ImportedSkill,
  type InstallContext,
  type InstallOperationLike,
  type TargetAdapter,
  type TargetDetection,
} from "@agentpack/schema";
import { parse } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { canonicalToMcpJson, canonicalToTomlValue, tomlTableToCanonical } from "./mcp.js";

const execFileAsync = promisify(execFile);

/** Skills installed by the sync flow live outside the Codex config roots. */
const SKILLS_DIRNAME = ".agents";

/** Marker relPath of the synthetic skill artifact that carries pack assets. */
const ASSETS_RELPATH = "assets";

function userConfigRoot(env: Record<string, string | undefined>, homeDir: string): string {
  return env.CODEX_HOME ?? path.join(homeDir, ".codex");
}

function projectConfigRoot(projectRoot: string): string {
  return path.join(projectRoot, ".codex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function enabledServers(pack: CanonicalPack) {
  return Object.values(pack.mcpServers).filter((server) => server.enabled !== false);
}

function pluginJson(pack: CanonicalPack): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: pack.metadata.name,
    version: pack.metadata.version,
  };
  if (pack.metadata.description) json.description = pack.metadata.description;
  if (pack.plugin?.interface) {
    const iface = Object.fromEntries(
      Object.entries(pack.plugin.interface).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(iface).length > 0) json.interface = iface;
  }
  if (pack.skills.length > 0) json.skills = pack.skills.map((skill) => `skills/${skill.name}`);
  if (enabledServers(pack).length > 0) json.mcpServers = "./.mcp.json";
  if (pack.hooks.length > 0) json.hooks = "./hooks";
  // Optimistic: planInstall strips this pointer when the pack has no assets.
  json.assets = "./assets";
  const codexExtensions = pack.targetExtensions.codex;
  if (codexExtensions) json["x-codex"] = codexExtensions;
  return json;
}

function bundleArtifacts(pack: CanonicalPack): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [
    {
      kind: "file",
      root: "bundle",
      relPath: ".codex-plugin/plugin.json",
      content: renderJson(pluginJson(pack)),
    },
  ];
  for (const skill of pack.skills) {
    artifacts.push({
      kind: "skill",
      root: "bundle",
      name: skill.name,
      sourceDir: skill.rootDir,
      relPath: `skills/${skill.name}`,
    });
  }
  const servers = enabledServers(pack);
  if (servers.length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const server of servers) mcpServers[server.name] = canonicalToMcpJson(server);
    artifacts.push({
      kind: "file",
      root: "bundle",
      relPath: ".mcp.json",
      content: renderJson({ mcpServers }),
    });
  }
  for (const hook of pack.hooks) {
    const data: Record<string, unknown> = { id: hook.id, event: hook.event };
    if (hook.matcher) data.matcher = hook.matcher;
    data.command = [...hook.command];
    artifacts.push({
      kind: "file",
      root: "bundle",
      relPath: `hooks/${hook.id}.json`,
      content: renderJson(data),
    });
  }
  // Synthetic artifact: planInstall stats the source and copies it only when
  // the pack actually ships an assets directory with files.
  artifacts.push({
    kind: "skill",
    root: "bundle",
    name: ASSETS_RELPATH,
    sourceDir: path.join(pack.rootDir, ASSETS_RELPATH),
    relPath: ASSETS_RELPATH,
  });
  return artifacts;
}

async function directoryHasEntries(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => undefined);
  return entries !== undefined && entries.length > 0;
}

/** Remove the optimistic "assets" pointer from the planned plugin.json op. */
function stripAssetsPointer(ops: InstallOperationLike[], bundleRoot: string): void {
  const pluginPath = path.join(bundleRoot, ".codex-plugin", "plugin.json");
  const op = ops.find(
    (candidate) => candidate.type === "writeFile" && candidate.path === pluginPath,
  );
  if (!op || op.type !== "writeFile") return;
  const json = JSON.parse(op.content) as Record<string, unknown>;
  delete json.assets;
  op.content = renderJson(json);
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  try {
    const parsed: unknown = parseYaml(match[1]!);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const MAX_SKILL_FILE_BYTES = 1024 * 1024;

async function collectSkillFiles(
  rootDir: string,
  dir: string,
  out: Record<string, string>,
): Promise<void> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await collectSkillFiles(rootDir, full, out);
    } else if (dirent.isFile()) {
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat || stat.size > MAX_SKILL_FILE_BYTES) continue;
      const buffer = await fs.readFile(full);
      if (buffer.includes(0)) continue; // binary file
      out[toPosixPath(path.relative(rootDir, full))] = buffer.toString("utf8");
    }
  }
}

async function importSkills(skillsRoot: string): Promise<ImportedSkill[]> {
  const dirents = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch(() => [] as import("node:fs").Dirent[]);
  const skills: ImportedSkill[] = [];
  for (const dirent of [...dirents].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = path.join(skillsRoot, dirent.name);
    const stat = await fs.stat(dir).catch(() => undefined); // follows symlinks
    if (!stat?.isDirectory()) continue;
    const files: Record<string, string> = {};
    await collectSkillFiles(dir, dir, files);
    if (files["SKILL.md"] === undefined) continue;
    const frontmatter = parseFrontmatter(files["SKILL.md"]);
    const lines = Object.keys(files)
      .sort()
      .map((rel) => `${rel}:${sha256(files[rel]!)}`);
    skills.push({
      name: typeof frontmatter.name === "string" ? frontmatter.name : dirent.name,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
      files,
      contentHash: sha256(lines.join("\n")),
    });
  }
  return skills;
}

/** Target adapter for OpenAI Codex. */
export class CodexAdapter implements TargetAdapter {
  readonly id = "codex" as const;

  async detect(context: DetectionContext): Promise<TargetDetection> {
    const warnings: string[] = [];
    const roots = {
      userConfigRoot: userConfigRoot(context.env, context.homeDir),
      projectConfigRoot: projectConfigRoot(context.projectRoot),
    };
    const executablePath = context.findExecutable
      ? await context.findExecutable("codex")
      : undefined;
    if (!executablePath) return { installed: false, warnings, ...roots };

    let version: string | undefined;
    try {
      const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
        timeout: 5000,
      });
      const text = (stdout || stderr).trim();
      version = /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? (text || undefined);
    } catch {
      warnings.push(`failed to run \`codex --version\` (${executablePath}); version unknown`);
    }
    return { installed: true, executablePath, version, warnings, ...roots };
  }

  analyze(pack: CanonicalPack, _context: AdapterContext): Promise<CapabilityReport> {
    const findings: CapabilityFinding[] = [];
    for (const skill of pack.skills) {
      findings.push({
        target: "codex",
        componentType: "skill",
        componentId: skill.name,
        support: "native",
      });
    }
    for (const server of Object.values(pack.mcpServers)) {
      if (server.enabled === false) continue;
      if (server.transport === "stdio") {
        findings.push({
          target: "codex",
          componentType: "mcp",
          componentId: server.name,
          support: "native",
        });
      } else if (server.transport === "http") {
        findings.push({
          target: "codex",
          componentType: "mcp",
          componentId: server.name,
          support: "transpiled",
          message: "rendered to config.toml mcp_servers",
        });
      } else {
        findings.push({
          target: "codex",
          componentType: "mcp",
          componentId: server.name,
          support: "degraded",
          message: "Codex has deprecated the sse transport",
          remediation: "use the http transport instead",
        });
      }
      if ((server.allowTools?.length ?? 0) > 0 || (server.denyTools?.length ?? 0) > 0) {
        findings.push({
          target: "codex",
          componentType: "mcp",
          componentId: server.name,
          support: "degraded",
          message: "allowTools/denyTools have no Codex config.toml equivalent and are not rendered",
          remediation: "rely on the native agent's approval system",
        });
      }
    }
    for (const instruction of pack.instructions) {
      findings.push({
        target: "codex",
        componentType: "instruction",
        componentId: instruction.id,
        support: "native",
      });
    }
    if (pack.plugin?.enabled) {
      findings.push({
        target: "codex",
        componentType: "plugin",
        componentId: pack.metadata.name,
        support: "native",
      });
    }
    for (const hook of pack.hooks) {
      findings.push({
        target: "codex",
        componentType: "hook",
        componentId: hook.id,
        support: "unsupported",
        message: "Codex has no hook system",
        remediation:
          "use a skill or CI check instead; the hook is still exported into the plugin bundle",
      });
    }
    return Promise.resolve({ findings });
  }

  generate(pack: CanonicalPack, context: AdapterContext): Promise<GeneratedArtifact[]> {
    if (context.options.bundle === true) {
      return Promise.resolve(bundleArtifacts(pack));
    }
    const artifacts: GeneratedArtifact[] = [];
    const scopeRoot: ArtifactRoot = context.scope === "project" ? "projectConfig" : "userConfig";

    for (const skill of pack.skills) {
      artifacts.push({
        kind: "skill",
        root: scopeRoot,
        name: skill.name,
        sourceDir: skill.rootDir,
        relPath: `skills/${skill.name}`,
      });
    }
    for (const server of enabledServers(pack)) {
      artifacts.push({
        kind: "toml-merge",
        root: scopeRoot,
        relPath: "config.toml",
        table: ["mcp_servers", server.name],
        value: canonicalToTomlValue(server),
      });
    }
    for (const instruction of pack.instructions) {
      if (instruction.targets && !instruction.targets.includes("codex")) continue;
      const append = instruction.mergeStrategy === "append";
      if (instruction.scope === "global") {
        artifacts.push({
          kind: "markdown-section",
          root: "userConfig",
          relPath: "AGENTS.md",
          sectionId: instruction.id,
          content: instruction.content,
          append,
        });
      } else {
        const directory = instruction.scope === "directory" ? instruction.directory : undefined;
        artifacts.push({
          kind: "markdown-section",
          root: "projectConfig",
          relPath: directory ? `${toPosixPath(directory)}/AGENTS.md` : "AGENTS.md",
          sectionId: instruction.id,
          content: instruction.content,
          append,
        });
      }
    }
    return Promise.resolve(artifacts);
  }

  async planInstall(
    artifacts: GeneratedArtifact[],
    context: InstallContext,
  ): Promise<InstallOperationLike[]> {
    const bundleRoot = context.bundleRoot;
    const configRoots: Record<"projectConfig" | "userConfig", string> = {
      projectConfig: context.detection.projectConfigRoot || projectConfigRoot(context.projectRoot),
      userConfig: context.detection.userConfigRoot || userConfigRoot(context.env, context.homeDir),
    };
    const configDest = (root: ArtifactRoot, relPath: string): string => {
      if (root === "bundle") {
        if (!bundleRoot) throw new Error("bundle artifact planned without a bundleRoot");
        return path.join(bundleRoot, relPath);
      }
      return path.join(configRoots[root], relPath);
    };

    const ops: InstallOperationLike[] = [];
    let assetsSkipped = false;
    for (const artifact of artifacts) {
      switch (artifact.kind) {
        case "file":
          ops.push({
            type: "writeFile",
            path: configDest(artifact.root, artifact.relPath),
            content: artifact.content,
            executable: artifact.executable,
          });
          break;
        case "json-merge":
          ops.push({
            type: "mergeJson",
            path: configDest(artifact.root, artifact.relPath),
            pointer: artifact.pointer,
            value: artifact.value,
          });
          break;
        case "toml-merge":
          ops.push({
            type: "mergeToml",
            path: configDest(artifact.root, artifact.relPath),
            table: artifact.table,
            value: artifact.value,
          });
          break;
        case "markdown-section": {
          // AGENTS.md lives at the project root (or a subdirectory), never
          // inside .codex/; global instructions live in the user config root.
          const dest =
            artifact.root === "projectConfig"
              ? path.join(context.projectRoot, artifact.relPath)
              : configDest(artifact.root, artifact.relPath);
          ops.push({
            type: "managedMarkdownSection",
            path: dest,
            sectionId: artifact.sectionId,
            content: artifact.content,
            append: artifact.append,
          });
          break;
        }
        case "skill": {
          if (artifact.root === "bundle") {
            if (!bundleRoot) throw new Error("bundle artifact planned without a bundleRoot");
            if (artifact.relPath === ASSETS_RELPATH && artifact.name === ASSETS_RELPATH) {
              if (!(await directoryHasEntries(artifact.sourceDir))) {
                assetsSkipped = true;
                break;
              }
            }
            ops.push({
              type: "copyDirectory",
              source: artifact.sourceDir,
              dest: path.join(bundleRoot, artifact.relPath),
            });
            break;
          }
          const base =
            artifact.root === "projectConfig"
              ? path.join(context.projectRoot, SKILLS_DIRNAME)
              : path.join(context.homeDir, SKILLS_DIRNAME);
          const dest = path.join(base, artifact.relPath);
          if (
            context.installMode === "symlink" ||
            (context.installMode === "auto" && context.symlinksReliable)
          ) {
            ops.push({ type: "createSymlink", path: dest, target: artifact.sourceDir });
          } else {
            ops.push({ type: "copyDirectory", source: artifact.sourceDir, dest });
          }
          break;
        }
      }
    }
    if (assetsSkipped && bundleRoot) stripAssetsPointer(ops, bundleRoot);
    return ops;
  }

  async nativeSources(context: ImportContext): Promise<string[]> {
    return [
      path.join(userConfigRoot(context.env, context.homeDir), "config.toml"),
      path.join(context.homeDir, SKILLS_DIRNAME, "skills"),
    ];
  }

  async import(context: ImportContext): Promise<ImportedConfiguration> {
    const warnings: string[] = [];
    const mcpServers: ImportedConfiguration["mcpServers"] = {};
    const instructions: ImportedInstruction[] = [];
    const extensions: Record<string, unknown> = {};

    const userRoot = userConfigRoot(context.env, context.homeDir);
    const configRoot = context.scope === "user" ? userRoot : projectConfigRoot(context.projectRoot);

    const configPath = path.join(configRoot, "config.toml");
    const rawConfig = await readFileIfExists(configPath);
    if (rawConfig !== undefined && rawConfig.trim() !== "") {
      try {
        const doc: unknown = parse(rawConfig);
        const table = isPlainObject(doc) ? doc["mcp_servers"] : undefined;
        if (isPlainObject(table)) {
          const extras: Record<string, unknown> = {};
          for (const [name, value] of Object.entries(table)) {
            if (!isPlainObject(value)) continue;
            const result = tomlTableToCanonical(value);
            mcpServers[name] = result.server;
            if (Object.keys(result.extras).length > 0) extras[name] = result.extras;
          }
          if (Object.keys(extras).length > 0) extensions.configToml = { mcpServers: extras };
        }
      } catch (error) {
        warnings.push(`could not parse ${configPath}: ${(error as Error).message}`);
      }
    }

    const agentsPath =
      context.scope === "user"
        ? path.join(userRoot, "AGENTS.md")
        : path.join(context.projectRoot, "AGENTS.md");
    const agents = await readFileIfExists(agentsPath);
    if (agents !== undefined) {
      const instructionScope = context.scope === "user" ? "global" : "project";
      const sectionIds = listManagedSections(agents);
      if (sectionIds.length > 0) {
        for (const id of sectionIds) {
          instructions.push({
            id,
            content: sectionContent(agents, id) ?? "",
            scope: instructionScope,
          });
        }
      } else if (agents.trim() !== "") {
        instructions.push({ id: "imported-codex", content: agents, scope: instructionScope });
      }
    }

    const skillsRoot =
      context.scope === "user"
        ? path.join(context.homeDir, SKILLS_DIRNAME, "skills")
        : path.join(context.projectRoot, SKILLS_DIRNAME, "skills");
    const skills = await importSkills(skillsRoot);

    return { skills, mcpServers, instructions, extensions, warnings };
  }
}

export function createCodexAdapter(): TargetAdapter {
  return new CodexAdapter();
}

export const codexAdapter: TargetAdapter = createCodexAdapter();
