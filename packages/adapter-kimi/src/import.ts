import { promises as fs } from "node:fs";
import path from "node:path";

import { listManagedSections, sectionContent, sha256 } from "@agentpack/filesystem";
import type {
  CanonicalMcpServer,
  EnvValue,
  ImportContext,
  ImportedConfiguration,
  ImportedInstruction,
  ImportedSkill,
} from "@agentpack/schema";
import { parse as parseYaml } from "yaml";

import { projectConfigRoot, resolveKimiHome } from "./paths.js";

const MAX_SKILL_FILE_BYTES = 1024 * 1024;

const KNOWN_SERVER_KEYS = new Set([
  "type",
  "command",
  "args",
  "cwd",
  "url",
  "headers",
  "env",
  "passEnv",
  "startupTimeoutMs",
  "toolTimeoutMs",
  "approval",
  "allowTools",
  "denyTools",
]);

const ENV_REF_EXACT = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/* --------------------------------- MCP --------------------------------- */

/** Map a native "${VAR}" string back to a canonical EnvValue. */
export function envValueFromNative(raw: string): EnvValue {
  const exact = ENV_REF_EXACT.exec(raw);
  if (exact) return { fromEnv: exact[1]! };
  const refs = [...raw.matchAll(ENV_REF)].map((match) => match[1]!);
  if (refs.length > 0) return { template: raw, requiredEnv: [...new Set(refs)] };
  return { value: raw };
}

function envRecordFromNative(raw: unknown): Record<string, EnvValue> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, EnvValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = envValueFromNative(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

function isApproval(raw: unknown): raw is { default: "prompt" | "always" | "never" } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = (raw as Record<string, unknown>).default;
  return value === "prompt" || value === "always" || value === "never";
}

type ServerImport =
  | {
      spec: Omit<CanonicalMcpServer, "name">;
      extensions?: Record<string, unknown>;
    }
  | { warning: string };

/** Map a native mcp.json server entry back to a canonical McpServerSpec. */
export function serverFromNative(name: string, raw: unknown): ServerImport {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { warning: `mcp server "${name}": expected an object, skipped` };
  }
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    return { warning: `mcp server "${name}": missing or unknown "type", skipped` };
  }

  const spec: Record<string, unknown> = { transport: type, enabled: true };
  if (type === "stdio") {
    if (typeof record.command !== "string" || record.command === "") {
      return { warning: `mcp server "${name}": stdio transport requires "command", skipped` };
    }
    spec.command = record.command;
    const args = stringArray(record.args);
    if (args) spec.args = args;
    if (typeof record.cwd === "string") spec.cwd = record.cwd;
    const env = envRecordFromNative(record.env);
    if (env) spec.env = env;
  } else {
    if (typeof record.url !== "string" || record.url === "") {
      return { warning: `mcp server "${name}": ${type} transport requires "url", skipped` };
    }
    spec.url = record.url;
    const headers = envRecordFromNative(record.headers);
    if (headers) spec.headers = headers;
  }
  const passEnv = stringArray(record.passEnv);
  if (passEnv) spec.passEnv = passEnv;
  if (typeof record.startupTimeoutMs === "number") {
    spec.startupTimeoutMs = record.startupTimeoutMs;
  }
  if (typeof record.toolTimeoutMs === "number") spec.toolTimeoutMs = record.toolTimeoutMs;
  if (isApproval(record.approval)) spec.approval = { default: record.approval.default };
  const allowTools = stringArray(record.allowTools);
  if (allowTools) spec.allowTools = allowTools;
  const denyTools = stringArray(record.denyTools);
  if (denyTools) spec.denyTools = denyTools;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_SERVER_KEYS.has(key)) extra[key] = value;
  }

  return {
    spec: spec as Omit<CanonicalMcpServer, "name">,
    extensions: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

/* ----------------------------- Instructions ----------------------------- */

async function importInstructions(
  files: Array<{ path: string; scope: "global" | "project" }>,
): Promise<ImportedInstruction[]> {
  const out: ImportedInstruction[] = [];
  let wholeFileCount = 0;
  for (const { path: file, scope } of files) {
    const content = await readTextIfExists(file);
    if (content === undefined || content.trim() === "") continue;
    const sections = listManagedSections(content);
    if (sections.length > 0) {
      for (const id of sections) {
        const body = sectionContent(content, id);
        if (body !== undefined) out.push({ id, content: body, scope });
      }
    } else {
      wholeFileCount += 1;
      out.push({
        id: wholeFileCount === 1 ? "imported-kimi" : `imported-kimi-${wholeFileCount}`,
        content: content.replace(/\s+$/u, ""),
        scope,
      });
    }
  }
  return out;
}

/* -------------------------------- Skills -------------------------------- */

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

async function collectSkillFiles(
  root: string,
  dir: string,
  out: Record<string, string>,
  warnings: string[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      await collectSkillFiles(root, full, out, warnings);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(full).catch(() => undefined);
    if (!stat || stat.size > MAX_SKILL_FILE_BYTES) {
      warnings.push(`skipped large file in imported skill: ${full}`);
      continue;
    }
    const buffer = await fs.readFile(full);
    if (buffer.includes(0)) {
      warnings.push(`skipped binary file in imported skill: ${full}`);
      continue;
    }
    out[rel] = buffer.toString("utf8");
  }
}

async function readSkillDir(
  dir: string,
  dirName: string,
  warnings: string[],
): Promise<ImportedSkill | undefined> {
  const skillMd = path.join(dir, "SKILL.md");
  const stat = await fs.stat(skillMd).catch(() => undefined);
  if (!stat?.isFile()) return undefined;

  const files: Record<string, string> = {};
  await collectSkillFiles(dir, dir, files, warnings);
  const skillContent = files["SKILL.md"];
  if (skillContent === undefined) return undefined;

  const frontmatter = parseFrontmatter(skillContent);
  const name =
    typeof frontmatter.name === "string" && frontmatter.name.length > 0
      ? frontmatter.name
      : dirName;
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

  const material = Object.keys(files)
    .sort()
    .map((rel) => `${rel}:${sha256(files[rel]!)}`)
    .join("\n");
  return { name, description, files, contentHash: sha256(material) };
}

async function importSkills(baseDirs: string[], warnings: string[]): Promise<ImportedSkill[]> {
  const out: ImportedSkill[] = [];
  const seen = new Set<string>();
  for (const base of baseDirs) {
    let entries;
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const resolved = path.resolve(dir);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const skill = await readSkillDir(dir, entry.name, warnings);
      if (skill) out.push(skill);
    }
  }
  return out;
}

/* ----------------------------- Native sources ----------------------------- */

/**
 * Native files/dirs that collect mode watches for user-scope changes.
 * Paths are returned whether or not they exist.
 */
export function nativeSourcesKimi(context: ImportContext): Promise<string[]> {
  const kimiHome = resolveKimiHome(context.env, context.homeDir);
  return Promise.resolve([
    path.join(kimiHome, "mcp.json"),
    path.join(kimiHome, "skills"),
    path.join(context.homeDir, ".agents", "skills"),
  ]);
}

/* -------------------------------- Import -------------------------------- */

/** Read Kimi Code native config into canonical form. Never modifies it. */
export async function importKimi(context: ImportContext): Promise<ImportedConfiguration> {
  const warnings: string[] = [];
  const kimiHome = resolveKimiHome(context.env, context.homeDir);
  const scope = context.scope;

  const mcpServers: Record<string, Omit<CanonicalMcpServer, "name">> = {};
  const extensions: Record<string, unknown> = {};

  const mcpPath =
    scope === "project"
      ? path.join(projectConfigRoot(context.projectRoot), "mcp.json")
      : path.join(kimiHome, "mcp.json");
  const mcpRaw = await readTextIfExists(mcpPath);
  if (mcpRaw !== undefined && mcpRaw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(mcpRaw);
    } catch (error) {
      warnings.push(`failed to parse ${mcpPath}: ${(error as Error).message}`);
      parsed = undefined;
    }
    const servers =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).mcpServers
        : undefined;
    if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
      const serverExtensions: Record<string, unknown> = {};
      for (const [name, raw] of Object.entries(servers)) {
        const result = serverFromNative(name, raw);
        if ("warning" in result) {
          warnings.push(result.warning);
          continue;
        }
        mcpServers[name] = result.spec;
        if (result.extensions) serverExtensions[name] = result.extensions;
      }
      if (Object.keys(serverExtensions).length > 0) {
        extensions.mcpServerExtensions = serverExtensions;
      }
    }
  }

  const instructionFiles =
    scope === "project"
      ? [
          { path: path.join(context.projectRoot, "AGENTS.md"), scope: "project" as const },
          {
            path: path.join(projectConfigRoot(context.projectRoot), "AGENTS.md"),
            scope: "project" as const,
          },
        ]
      : [{ path: path.join(kimiHome, "AGENTS.md"), scope: "global" as const }];
  const instructions = await importInstructions(instructionFiles);

  const skillBases =
    scope === "project"
      ? [
          path.join(context.projectRoot, ".agents", "skills"),
          path.join(projectConfigRoot(context.projectRoot), "skills"),
        ]
      : [path.join(context.homeDir, ".agents", "skills"), path.join(kimiHome, "skills")];
  const skills = await importSkills(skillBases, warnings);

  return { skills, mcpServers, instructions, extensions, warnings };
}
