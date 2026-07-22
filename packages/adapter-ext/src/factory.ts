import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { listManagedSections, pathExists, sectionContent, sha256 } from "@agentpack/filesystem";
import type {
  AdapterContext,
  CanonicalHook,
  CanonicalInstruction,
  CanonicalMcpServer,
  CanonicalPack,
  CapabilityFinding,
  CapabilityReport,
  DetectionContext,
  EnvValue,
  GeneratedArtifact,
  ImportContext,
  ImportedConfiguration,
  ImportedInstruction,
  ImportedSkill,
  InstallContext,
  InstallOperationLike,
  TargetAdapter,
  TargetDetection,
  TargetId,
} from "@agentpack/schema";
import { renderEnvRecord } from "@agentpack/schema";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);

/* ------------------------------- Spec -------------------------------- */

/**
 * How env references are rendered in a target's native MCP config:
 * - "plain": `${VAR}`
 * - "env":   `${env:VAR}` (VS Code-family tools)
 * - "brace": `{env:VAR}`  (opencode-style tools)
 */
export type EnvRefFormat = "plain" | "env" | "brace";

export interface SimpleAdapterSpec {
  id: TargetId;
  /** PATH detection candidates, probed in order. */
  executables: string[];
  userConfigRoot: (ctx: DetectionContext) => string;
  projectConfigRoot: (ctx: DetectionContext) => string;
  /** Env var that relocates the user config root (e.g. CLINE_DATA_DIR). */
  envOverride?: string;
  /**
   * Skill install directories. Omit the whole field when the target has no
   * skills concept (analyze reports "unsupported"); omit `user` when only a
   * project-scope skills directory is documented. The user function also
   * receives the environment so specs can honor config-root env overrides.
   */
  skills?: {
    user?: (home: string, env: Record<string, string | undefined>) => string;
    project?: (root: string) => string;
  };
  /** Remediation used when skills are unsupported (spec.skills undefined). */
  skillsUnsupportedRemediation?: string;
  mcp: {
    /** Absolute MCP config file for the user scope. */
    user: (ctx: AdapterContext) => string;
    /** Absolute MCP config file for the project scope; undefined = unsupported. */
    project?: (ctx: AdapterContext) => string;
    /** json → mergeJson; yaml → mergeYaml (the YAML engine also parses JSONC);
     *  toml → mergeToml with topKey as the table path. */
    format: "json" | "yaml" | "toml";
    /** Pointer segments above the server name, e.g. ["mcpServers"] or ["mcp"]. */
    topKey: string[];
    /** Native entry shape for one canonical server. */
    serverValue: (server: CanonicalMcpServer) => unknown;
    /**
     * Map a native entry back to canonical form for import. Return undefined
     * to skip an unrecognized entry (reported as a warning). Omit the field
     * to disable MCP import entirely.
     */
    parseServer?: (name: string, raw: unknown) => Omit<CanonicalMcpServer, "name"> | undefined;
  };
  instructions: {
    /** Project-scope file, relative to the project root (e.g. "AGENTS.md"). */
    projectFile?: string;
    /** User-scope file, relative to the user config root. */
    userFile?: string;
    /** Directory-scope file, relative to the project root. */
    directoryFile?: (dir: string) => string;
  };
  /**
   * MVP hook support: "unsupported" reports every canonical hook as
   * unsupported; "hooksJson" merges entries into <configRoot>/hooks.json and
   * reports them as transpiled.
   */
  hooks: { support: "unsupported" } | { support: "hooksJson" };
  /** Extra paths whose existence counts as an installation signal. */
  extraDetectionPaths?: (ctx: DetectionContext) => string[];
  /**
   * Legacy layout: when no primary signal (executable, current config roots,
   * extra paths) is found but one of these paths exists, the target is still
   * reported installed and this warning is attached.
   */
  legacyLayout?: { paths: (ctx: DetectionContext) => string[]; warning: string };
  /** Override for nativeSources; default is the user MCP file + user skills dir. */
  nativeSourcesPaths?: (ctx: ImportContext) => string[];
}

/* ---------------------------- Shared helpers -------------------------- */

const HOOKS_FILE = "hooks.json";

function pathContextOf(ctx: {
  env: Record<string, string | undefined>;
  homeDir: string;
  projectRoot: string;
}): DetectionContext {
  return {
    env: ctx.env,
    homeDir: ctx.homeDir,
    projectRoot: ctx.projectRoot,
    platform: process.platform,
  };
}

function resolveUserConfigRoot(
  spec: SimpleAdapterSpec,
  ctx: {
    env: Record<string, string | undefined>;
    homeDir: string;
    projectRoot: string;
  },
): string {
  if (spec.envOverride) {
    const override = ctx.env[spec.envOverride];
    if (override && override.length > 0) return override;
  }
  return spec.userConfigRoot(pathContextOf(ctx));
}

function adapterContextOf(ctx: ImportContext | InstallContext): AdapterContext {
  return {
    scope: ctx.scope,
    projectRoot: ctx.projectRoot,
    homeDir: ctx.homeDir,
    env: ctx.env,
    detection: {
      installed: false,
      userConfigRoot: "",
      projectConfigRoot: "",
      warnings: [],
    },
    options: ctx.options,
  };
}

/** A component without an explicit target list applies to every target. */
function targetsThis(id: TargetId, targets: TargetId[] | undefined): boolean {
  return !targets || targets.includes(id);
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/* ----------------------------- Env values ----------------------------- */

export function envRefFormatter(format: EnvRefFormat): (varName: string) => string {
  switch (format) {
    case "plain":
      return (name) => `\${${name}}`;
    case "env":
      return (name) => `\${env:${name}}`;
    case "brace":
      return (name) => `{env:${name}}`;
  }
}

/** Render an EnvValue map to native strings using the given reference syntax. */
export function renderEnv(
  record: Record<string, EnvValue> | undefined,
  format: EnvRefFormat,
): Record<string, string> | undefined {
  return renderEnvRecord(record, envRefFormatter(format));
}

const ENV_REF_EXACT =
  /^(?:\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\})$/;
const ENV_REF_ANY =
  /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Map a native env-reference string back to a canonical EnvValue. */
export function envValueFromNative(raw: string): EnvValue {
  const exact = ENV_REF_EXACT.exec(raw);
  if (exact) return { fromEnv: (exact[1] ?? exact[2] ?? exact[3])! };
  const refs = [...raw.matchAll(ENV_REF_ANY)].map((match) => (match[1] ?? match[2] ?? match[3])!);
  if (refs.length > 0) return { template: raw, requiredEnv: [...new Set(refs)] };
  return { value: raw };
}

/** Parse a native env/headers record, keeping only string values. */
export function envRecordFromNative(raw: unknown): Record<string, EnvValue> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, EnvValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = envValueFromNative(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ------------------------- MCP server shapes -------------------------- */

export interface ServerShapeOptions {
  envRef: EnvRefFormat;
  /** Key carrying the server URL; default "url". */
  urlKey?: "url" | "serverUrl";
  /**
   * Key carrying the URL of HTTP-transport entries when it differs from the
   * SSE key (e.g. Gemini CLI uses "httpUrl" for HTTP and "url" for SSE).
   * On import, the presence of this key implies the http transport.
   */
  httpUrlKey?: string;
  /** Explicit "type" value for stdio entries (omitted when undefined). */
  stdioType?: string;
  /** Explicit "type" value for http entries (omitted when undefined). */
  httpType?: string;
  /** Explicit "type" value for sse entries (omitted when undefined). */
  sseType?: string;
  /** Include `cwd` on stdio entries. */
  cwd?: boolean;
  /**
   * Key carrying the transport on entries that use "transport" instead of
   * "type" (e.g. OpenClaw, Mistral Vibe). raw.type is still read first.
   */
  transportKey?: string;
  /**
   * Transport assumed for URL entries without an explicit "type" on import.
   * When undefined, a typeless URL entry is skipped.
   */
  defaultRemoteTransport?: "http" | "sse";
}

/**
 * Native MCP server entry for the common `mcpServers`-style schema. Only set
 * keys are emitted, in a deterministic order; env/headers keep native env
 * references unresolved.
 */
export function buildServerValue(
  server: CanonicalMcpServer,
  options: ServerShapeOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (server.transport === "stdio") {
    if (options.stdioType) out.type = options.stdioType;
    out.command = server.command;
    if (server.args) out.args = server.args;
    const env = renderEnv(server.env, options.envRef);
    if (env) out.env = env;
    if (options.cwd && server.cwd) out.cwd = server.cwd;
  } else {
    const type = server.transport === "http" ? options.httpType : options.sseType;
    if (type) out.type = type;
    const key =
      server.transport === "http" && options.httpUrlKey
        ? options.httpUrlKey
        : (options.urlKey ?? "url");
    out[key] = server.url;
    const headers = renderEnv(server.headers, options.envRef);
    if (headers) out.headers = headers;
  }
  return out;
}

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

/** Inverse of buildServerValue for the common `mcpServers`-style schema. */
export function parseNativeServer(
  name: string,
  raw: unknown,
  options: ServerShapeOptions,
): Omit<CanonicalMcpServer, "name"> | undefined {
  void name;
  if (!isRecord(raw)) return undefined;
  const enabled = raw.disabled === true ? false : true;

  if (typeof raw.command === "string" && raw.command.length > 0) {
    const spec: Record<string, unknown> = {
      transport: "stdio",
      command: raw.command,
      enabled,
    };
    const args = stringArray(raw.args);
    if (args) spec.args = args;
    if (options.cwd && typeof raw.cwd === "string" && raw.cwd.length > 0) spec.cwd = raw.cwd;
    const env = envRecordFromNative(raw.env);
    if (env) spec.env = env;
    return spec as Omit<CanonicalMcpServer, "name">;
  }

  const urlKey = options.urlKey ?? "url";
  const httpUrl =
    options.httpUrlKey && typeof raw[options.httpUrlKey] === "string"
      ? (raw[options.httpUrlKey] as string)
      : undefined;
  const plainUrl =
    typeof raw[urlKey] === "string"
      ? (raw[urlKey] as string)
      : typeof raw.url === "string"
        ? raw.url
        : undefined;
  const url = httpUrl ?? plainUrl;
  if (url) {
    const type =
      typeof raw.type === "string"
        ? raw.type
        : options.transportKey && typeof raw[options.transportKey] === "string"
          ? (raw[options.transportKey] as string)
          : undefined;
    let transport: "http" | "sse" | undefined;
    if (type !== undefined && type === options.httpType) transport = "http";
    else if (type !== undefined && type === options.sseType) transport = "sse";
    else if (type === "http" || type === "sse") transport = type;
    else if (type === undefined) transport = httpUrl ? "http" : options.defaultRemoteTransport;
    if (!transport) return undefined;
    const spec: Record<string, unknown> = { transport, url, enabled };
    const headers = envRecordFromNative(raw.headers);
    if (headers) spec.headers = headers;
    return spec as Omit<CanonicalMcpServer, "name">;
  }

  return undefined;
}

/* --------------------------- VS Code paths ---------------------------- */

/**
 * User-data directory of a VS Code installation (stable "Code" variant;
 * Insiders uses "Code - Insiders", VSCodium "VSCodium" — noted where
 * relevant).
 */
export function vscodeUserDir(ctx: {
  env: Record<string, string | undefined>;
  homeDir: string;
  platform?: NodeJS.Platform;
}): string {
  const platform = ctx.platform ?? process.platform;
  if (platform === "darwin") {
    return path.join(ctx.homeDir, "Library", "Application Support", "Code", "User");
  }
  if (platform === "win32") {
    const appData = ctx.env.APPDATA ?? path.join(ctx.homeDir, "AppData", "Roaming");
    return path.join(appData, "Code", "User");
  }
  return path.join(ctx.homeDir, ".config", "Code", "User");
}

/**
 * globalStorage directory of a VS Code extension (stable "Code" variant;
 * Insiders/VSCodium use different parent dirs — noted where relevant).
 */
export function vscodeGlobalStorage(
  ctx: {
    env: Record<string, string | undefined>;
    homeDir: string;
    platform?: NodeJS.Platform;
  },
  extensionId: string,
): string {
  return path.join(vscodeUserDir(ctx), "globalStorage", extensionId);
}

/* ------------------------------- Detect ------------------------------- */

async function probeVersion(executablePath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
      timeout: 5000,
    });
    const text = (stdout || stderr).trim();
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(text);
    return match?.[1] ?? (text || undefined);
  } catch {
    return undefined;
  }
}

function makeDetect(spec: SimpleAdapterSpec): TargetAdapter["detect"] {
  return async (context: DetectionContext): Promise<TargetDetection> => {
    const userConfigRoot = resolveUserConfigRoot(spec, context);
    const projectConfigRoot = spec.projectConfigRoot(context);
    const warnings: string[] = [];

    let executablePath: string | undefined;
    let executableName: string | undefined;
    if (context.findExecutable) {
      for (const name of spec.executables) {
        const found = await context.findExecutable(name);
        if (found) {
          executablePath = found;
          executableName = name;
          break;
        }
      }
    }

    let version: string | undefined;
    if (executablePath && executableName) {
      version = await probeVersion(executablePath);
      if (!version) {
        warnings.push(
          `${spec.id} found at ${executablePath} but \`${executableName} --version\` failed`,
        );
      }
    }

    const extraPaths = spec.extraDetectionPaths?.(context) ?? [];
    const legacyPaths = spec.legacyLayout?.paths(context) ?? [];
    const existence = await Promise.all(
      [userConfigRoot, projectConfigRoot, ...extraPaths, ...legacyPaths].map((p) => pathExists(p)),
    );
    const hasUserConfig = existence[0] === true;
    const hasProjectConfig = existence[1] === true;
    const extraFound = existence.slice(2, 2 + extraPaths.length).some(Boolean);
    const legacyFound = existence.slice(2 + extraPaths.length).some(Boolean);

    const primary = executablePath !== undefined || hasUserConfig || hasProjectConfig || extraFound;
    if (!primary && legacyFound && spec.legacyLayout) {
      warnings.push(spec.legacyLayout.warning);
    }

    return {
      installed: primary || legacyFound,
      executablePath,
      version,
      userConfigRoot,
      projectConfigRoot,
      warnings,
    };
  };
}

/* ------------------------------- Analyze ------------------------------ */

function instructionRelPath(
  spec: SimpleAdapterSpec,
  instruction: CanonicalInstruction,
): string | undefined {
  if (instruction.scope === "global") return spec.instructions.userFile;
  if (instruction.scope === "directory") {
    return instruction.directory
      ? spec.instructions.directoryFile?.(instruction.directory)
      : undefined;
  }
  return spec.instructions.projectFile;
}

function makeAnalyze(spec: SimpleAdapterSpec): TargetAdapter["analyze"] {
  return async (pack: CanonicalPack, context: AdapterContext): Promise<CapabilityReport> => {
    const findings: CapabilityFinding[] = [];

    for (const skill of pack.skills) {
      if (!spec.skills) {
        findings.push({
          target: spec.id,
          componentType: "skill",
          componentId: skill.name,
          support: "unsupported",
          message: `${spec.id} has no skills directory`,
          remediation: spec.skillsUnsupportedRemediation,
        });
      } else if (context.scope === "user" && !spec.skills.user) {
        findings.push({
          target: spec.id,
          componentType: "skill",
          componentId: skill.name,
          support: "unsupported",
          message: `${spec.id} has no documented user-scope skills directory`,
          remediation: "sync skills at project scope instead",
        });
      } else if (context.scope === "project" && !spec.skills.project) {
        findings.push({
          target: spec.id,
          componentType: "skill",
          componentId: skill.name,
          support: "unsupported",
          message: `${spec.id} has no documented project-scope skills directory`,
          remediation: "sync skills at user scope instead",
        });
      } else {
        findings.push({
          target: spec.id,
          componentType: "skill",
          componentId: skill.name,
          support: "native",
        });
      }
    }

    for (const server of Object.values(pack.mcpServers)) {
      if (server.enabled === false) continue;
      if (context.scope === "project" && !spec.mcp.project) {
        findings.push({
          target: spec.id,
          componentType: "mcp",
          componentId: server.name,
          support: "degraded",
          message: `${spec.id} supports MCP configuration only at user scope`,
          remediation: "sync MCP servers at user scope instead",
        });
      } else {
        findings.push({
          target: spec.id,
          componentType: "mcp",
          componentId: server.name,
          support: "native",
        });
      }
    }

    for (const instruction of pack.instructions) {
      if (!targetsThis(spec.id, instruction.targets)) continue;
      if (instructionRelPath(spec, instruction)) {
        findings.push({
          target: spec.id,
          componentType: "instruction",
          componentId: instruction.id,
          support: "native",
        });
      } else {
        findings.push({
          target: spec.id,
          componentType: "instruction",
          componentId: instruction.id,
          support: "unsupported",
          message: `${spec.id} has no AgentPack-managed ${instruction.scope}-scope instruction file`,
          remediation: "move this instruction to project scope",
        });
      }
    }

    if (pack.plugin?.enabled) {
      findings.push({
        target: spec.id,
        componentType: "plugin",
        componentId: pack.metadata.name,
        support: "unsupported",
        message: `${spec.id} has no AgentPack-managed plugin format yet`,
        remediation: "ship the plugin natively or disable it for this target",
      });
    }

    for (const hook of pack.hooks) {
      if (!targetsThis(spec.id, hook.targets)) continue;
      if (spec.hooks.support === "hooksJson") {
        findings.push({
          target: spec.id,
          componentType: "hook",
          componentId: hook.id,
          support: "transpiled",
          message: "rendered to hooks.json",
        });
      } else {
        findings.push({
          target: spec.id,
          componentType: "hook",
          componentId: hook.id,
          support: "unsupported",
          message: `${spec.id} hooks are not managed by AgentPack`,
          remediation: "target has no AgentPack-managed hook format yet",
        });
      }
    }

    return { findings };
  };
}

/* ------------------------------- Generate ----------------------------- */

/**
 * hooks.json entry (Cursor/Windsurf flat-array-per-event shape). The
 * canonical command array is joined into a single shell string; the "all"
 * matcher alias is omitted.
 */
function buildHookEntry(hook: CanonicalHook): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: hook.command.join(" ") };
  if (hook.matcher && hook.matcher !== "all") entry.matcher = hook.matcher;
  return entry;
}

function groupHooksByEvent(hooks: CanonicalHook[]): Map<string, CanonicalHook[]> {
  const grouped = new Map<string, CanonicalHook[]>();
  for (const hook of hooks) {
    const list = grouped.get(hook.event);
    if (list) list.push(hook);
    else grouped.set(hook.event, [hook]);
  }
  return grouped;
}

function makeGenerate(spec: SimpleAdapterSpec): TargetAdapter["generate"] {
  return async (pack: CanonicalPack, context: AdapterContext): Promise<GeneratedArtifact[]> => {
    const root = context.scope === "project" ? "projectConfig" : "userConfig";
    const artifacts: GeneratedArtifact[] = [];

    if (
      spec.skills &&
      !(context.scope === "user" && !spec.skills.user) &&
      !(context.scope === "project" && !spec.skills.project)
    ) {
      for (const skill of pack.skills) {
        artifacts.push({
          kind: "skill",
          root,
          name: skill.name,
          sourceDir: skill.rootDir,
          relPath: `skills/${skill.name}`,
        });
      }
    }

    const mcpPath =
      context.scope === "project" ? spec.mcp.project?.(context) : spec.mcp.user(context);
    if (mcpPath) {
      for (const server of Object.values(pack.mcpServers)) {
        if (server.enabled === false) continue;
        // relPath is informational only: planInstall resolves the real file
        // from the spec because MCP files are not always under a config root.
        if (spec.mcp.format === "toml") {
          artifacts.push({
            kind: "toml-merge",
            root,
            relPath: path.basename(mcpPath),
            table: [...spec.mcp.topKey, server.name],
            value: spec.mcp.serverValue(server),
          });
        } else {
          const pointer = `/${[...spec.mcp.topKey, server.name].map(escapePointerSegment).join("/")}`;
          artifacts.push({
            kind: "json-merge",
            root,
            relPath: path.basename(mcpPath),
            pointer,
            value: spec.mcp.serverValue(server),
          });
        }
      }
    }

    for (const instruction of pack.instructions) {
      if (!targetsThis(spec.id, instruction.targets)) continue;
      const relPath = instructionRelPath(spec, instruction);
      if (!relPath) continue;
      artifacts.push({
        kind: "markdown-section",
        root: instruction.scope === "global" ? "userConfig" : "projectConfig",
        relPath,
        sectionId: instruction.id,
        content: instruction.content,
        append: instruction.mergeStrategy === "append" ? true : undefined,
      });
    }

    if (spec.hooks.support === "hooksJson") {
      const eligible = pack.hooks.filter((hook) => targetsThis(spec.id, hook.targets));
      for (const [event, hooks] of groupHooksByEvent(eligible)) {
        artifacts.push({
          kind: "json-merge",
          root,
          relPath: HOOKS_FILE,
          pointer: `/hooks/${escapePointerSegment(event)}`,
          value: hooks.map(buildHookEntry),
        });
      }
    }

    return artifacts;
  };
}

/* ------------------------------ Plan install -------------------------- */

function makePlanInstall(spec: SimpleAdapterSpec): TargetAdapter["planInstall"] {
  return async (
    artifacts: GeneratedArtifact[],
    context: InstallContext,
  ): Promise<InstallOperationLike[]> => {
    if (context.bundleRoot) {
      // Simple adapters are sync-only: they must never write to real config
      // paths during a plugin-bundle build. Core skips unsupported-plugin
      // targets, so reaching here is a programming error — fail loudly.
      throw new Error(
        `adapter "${spec.id}" does not support plugin bundle generation (bundleRoot was set)`,
      );
    }
    const useSymlink =
      context.installMode === "symlink" ||
      (context.installMode === "auto" && context.symlinksReliable);
    const userConfigRoot = resolveUserConfigRoot(spec, context);
    const projectConfigRoot = spec.projectConfigRoot(pathContextOf(context));
    const adapterCtx = adapterContextOf(context);

    const ops: InstallOperationLike[] = [];
    for (const artifact of artifacts) {
      switch (artifact.kind) {
        case "skill": {
          const base =
            artifact.root === "userConfig"
              ? spec.skills?.user?.(context.homeDir, context.env)
              : spec.skills?.project?.(context.projectRoot);
          if (!base) {
            throw new Error(`${spec.id} adapter: skill artifacts are not supported for this scope`);
          }
          const dest = path.join(base, artifact.name);
          ops.push(
            useSymlink
              ? { type: "createSymlink", path: dest, target: artifact.sourceDir }
              : { type: "copyDirectory", source: artifact.sourceDir, dest },
          );
          break;
        }
        case "json-merge": {
          if (artifact.relPath === HOOKS_FILE) {
            const base = artifact.root === "userConfig" ? userConfigRoot : projectConfigRoot;
            ops.push({
              type: "mergeJson",
              path: path.join(base, HOOKS_FILE),
              pointer: artifact.pointer,
              value: artifact.value,
            });
            break;
          }
          const file =
            artifact.root === "userConfig"
              ? spec.mcp.user(adapterCtx)
              : spec.mcp.project?.(adapterCtx);
          if (!file) {
            throw new Error(`${spec.id} adapter: no MCP file for scope "${artifact.root}"`);
          }
          ops.push(
            spec.mcp.format === "yaml"
              ? { type: "mergeYaml", path: file, pointer: artifact.pointer, value: artifact.value }
              : { type: "mergeJson", path: file, pointer: artifact.pointer, value: artifact.value },
          );
          break;
        }
        case "markdown-section": {
          // Project instruction files are relative to the project root; user
          // instruction files are relative to the user config root.
          const base = artifact.root === "userConfig" ? userConfigRoot : context.projectRoot;
          ops.push({
            type: "managedMarkdownSection",
            path: path.join(base, ...artifact.relPath.split("/")),
            sectionId: artifact.sectionId,
            content: artifact.content,
            append: artifact.append,
          });
          break;
        }
        case "file": {
          const base = artifact.root === "userConfig" ? userConfigRoot : context.projectRoot;
          ops.push({
            type: "writeFile",
            path: path.join(base, ...artifact.relPath.split("/")),
            content: artifact.content,
            executable: artifact.executable,
          });
          break;
        }
        case "toml-merge": {
          const file =
            artifact.root === "userConfig"
              ? spec.mcp.user(adapterCtx)
              : spec.mcp.project?.(adapterCtx);
          if (!file) {
            throw new Error(`${spec.id} adapter: no MCP file for scope "${artifact.root}"`);
          }
          ops.push({ type: "mergeToml", path: file, table: artifact.table, value: artifact.value });
          break;
        }
      }
    }
    return ops;
  };
}

/* -------------------------------- Import ------------------------------ */

const MAX_SKILL_FILE_BYTES = 1024 * 1024;

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    if (isRecord(parsed)) return parsed;
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

async function importInstructions(
  idPrefix: string,
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
        id: wholeFileCount === 1 ? idPrefix : `${idPrefix}-${wholeFileCount}`,
        content: content.replace(/\s+$/u, ""),
        scope,
      });
    }
  }
  return out;
}

function makeImport(spec: SimpleAdapterSpec): TargetAdapter["import"] {
  return async (context: ImportContext): Promise<ImportedConfiguration> => {
    const warnings: string[] = [];
    const adapterCtx = adapterContextOf(context);
    const mcpServers: Record<string, Omit<CanonicalMcpServer, "name">> = {};

    const mcpPath =
      context.scope === "project" ? spec.mcp.project?.(adapterCtx) : spec.mcp.user(adapterCtx);
    if (spec.mcp.parseServer && mcpPath) {
      const raw = await readTextIfExists(mcpPath);
      if (raw !== undefined && raw.trim() !== "") {
        let parsed: unknown;
        try {
          parsed =
            spec.mcp.format === "yaml"
              ? parseYaml(raw)
              : spec.mcp.format === "toml"
                ? parseToml(raw)
                : JSON.parse(raw);
        } catch (error) {
          warnings.push(`failed to parse ${mcpPath}: ${(error as Error).message}`);
          parsed = undefined;
        }
        let node: unknown = parsed;
        for (const key of spec.mcp.topKey) {
          node = isRecord(node) ? node[key] : undefined;
        }
        if (isRecord(node)) {
          for (const [name, entry] of Object.entries(node)) {
            const parsedServer = spec.mcp.parseServer(name, entry);
            if (parsedServer) mcpServers[name] = parsedServer;
            else warnings.push(`mcp server "${name}": unrecognized shape in ${mcpPath}, skipped`);
          }
        } else if (Array.isArray(node)) {
          // Array-of-tables form (e.g. TOML [[mcp_servers]] with a name field).
          for (const entry of node) {
            if (!isRecord(entry) || typeof entry.name !== "string") continue;
            const parsedServer = spec.mcp.parseServer(entry.name, entry);
            if (parsedServer) mcpServers[entry.name] = parsedServer;
            else {
              warnings.push(
                `mcp server "${entry.name}": unrecognized shape in ${mcpPath}, skipped`,
              );
            }
          }
        }
      }
    }

    const skillBases: string[] = [];
    if (spec.skills) {
      if (context.scope === "project" && spec.skills.project) {
        skillBases.push(spec.skills.project(context.projectRoot));
      } else if (context.scope === "user" && spec.skills.user) {
        skillBases.push(spec.skills.user(context.homeDir, context.env));
      }
    }
    const skills = await importSkills(skillBases, warnings);

    const userConfigRoot = resolveUserConfigRoot(spec, context);
    const instructionFiles: Array<{ path: string; scope: "global" | "project" }> = [];
    if (context.scope === "project" && spec.instructions.projectFile) {
      instructionFiles.push({
        path: path.join(context.projectRoot, ...spec.instructions.projectFile.split("/")),
        scope: "project",
      });
    }
    if (context.scope === "user" && spec.instructions.userFile) {
      instructionFiles.push({
        path: path.join(userConfigRoot, ...spec.instructions.userFile.split("/")),
        scope: "global",
      });
    }
    const instructions = await importInstructions(`imported-${spec.id}`, instructionFiles);

    return { skills, mcpServers, instructions, extensions: {}, warnings };
  };
}

function makeNativeSources(spec: SimpleAdapterSpec): TargetAdapter["nativeSources"] {
  return async (context: ImportContext): Promise<string[]> => {
    if (spec.nativeSourcesPaths) return spec.nativeSourcesPaths(context);
    const out = [spec.mcp.user(adapterContextOf(context))];
    const skillsUser = spec.skills?.user?.(context.homeDir, context.env);
    if (skillsUser) out.push(skillsUser);
    return out;
  };
}

/* ------------------------------- Factory ------------------------------ */

/** Build a full TargetAdapter from a declarative spec. */
export function defineSimpleAdapter(spec: SimpleAdapterSpec): TargetAdapter {
  return {
    id: spec.id,
    detect: makeDetect(spec),
    analyze: makeAnalyze(spec),
    generate: makeGenerate(spec),
    planInstall: makePlanInstall(spec),
    import: makeImport(spec),
    nativeSources: makeNativeSources(spec),
  };
}
