import type { CanonicalMcpServer, CanonicalPack } from "./ir.js";
import type { EnvValue } from "./secrets.js";
import type { CapabilityReport, InstallMode, Scope, TargetId } from "./targets.js";

/* ------------------------------ Contexts ----------------------------- */

export interface DetectionContext {
  env: Record<string, string | undefined>;
  homeDir: string;
  projectRoot: string;
  platform: NodeJS.Platform;
  /**
   * Resolve an executable name on PATH. Returns the absolute path or
   * undefined. Injectable so tests can fake agent installations.
   */
  findExecutable?: (name: string) => Promise<string | undefined>;
}

export interface TargetDetection {
  installed: boolean;
  executablePath?: string;
  version?: string;
  userConfigRoot: string;
  projectConfigRoot: string;
  warnings: string[];
}

export interface AdapterContext {
  scope: Scope;
  projectRoot: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  detection: TargetDetection;
  /** Adapter-specific options (e.g. kimi path strategy). */
  options: Record<string, unknown>;
}

export interface InstallContext extends AdapterContext {
  installMode: InstallMode;
  /**
   * When true, return operations that copy instead of symlink even in
   * `auto` mode (e.g. Windows or unsupported filesystems).
   */
  symlinksReliable: boolean;
  /** Absolute output directory — only set for `agentpack build`. */
  bundleRoot?: string;
}

export interface ImportContext {
  scope: Scope;
  projectRoot: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  options: Record<string, unknown>;
}

/* ----------------------------- Artifacts ----------------------------- */

/**
 * Adapters return data structures only. The core/installer turns them into
 * filesystem operations; adapters must never touch the filesystem for output.
 *
 * `root` declares which logical root `relPath` is relative to:
 * - "projectConfig": the target's project-scope config root
 * - "userConfig":    the target's user-scope config root
 * - "bundle":        the plugin bundle output directory (agentpack build)
 */
export type ArtifactRoot = "projectConfig" | "userConfig" | "bundle";

export type GeneratedArtifact =
  | {
      kind: "file";
      root: ArtifactRoot;
      relPath: string;
      content: string;
      executable?: boolean;
    }
  | {
      /** Install a skill directory (symlink or copy, decided by installer). */
      kind: "skill";
      root: ArtifactRoot;
      name: string;
      /** Absolute path of the canonical skill directory. */
      sourceDir: string;
      /** Relative destination directory (e.g. "skills/security-review"). */
      relPath: string;
    }
  | {
      /** Merge a value into a JSON file at a JSON pointer (object keys only). */
      kind: "json-merge";
      root: ArtifactRoot;
      relPath: string;
      pointer: string;
      value: unknown;
    }
  | {
      /** Merge a value into a TOML table path (e.g. ["mcp_servers","github"]). */
      kind: "toml-merge";
      root: ArtifactRoot;
      relPath: string;
      table: string[];
      value: unknown;
    }
  | {
      /** Upsert an AgentPack-managed section into a Markdown file. */
      kind: "markdown-section";
      root: ArtifactRoot;
      relPath: string;
      sectionId: string;
      content: string;
      /** If true, append instead of upserting a managed section. */
      append?: boolean;
    };

/* ------------------------------ Import ------------------------------- */

export interface ImportedSkill {
  name: string;
  description: string;
  /** File contents: POSIX relative path → text content. */
  files: Record<string, string>;
  /** Normalized content hash ("sha256:...") used for deduplication. */
  contentHash: string;
}

export interface ImportedInstruction {
  id: string;
  content: string;
  scope: "global" | "project" | "directory";
  directory?: string;
}

export interface ImportedConfiguration {
  skills: ImportedSkill[];
  mcpServers: Record<string, Omit<CanonicalMcpServer, "name">>;
  instructions: ImportedInstruction[];
  /** Target-specific data that cannot be normalized. */
  extensions: Record<string, unknown>;
  warnings: string[];
}

/* ------------------------------ Adapter ------------------------------ */

export interface TargetAdapter {
  readonly id: TargetId;

  /** Best-effort detection. Must not throw when the agent is absent. */
  detect(context: DetectionContext): Promise<TargetDetection>;

  /** Classify every component of the pack for this target. */
  analyze(pack: CanonicalPack, context: AdapterContext): Promise<CapabilityReport>;

  /** Generate native artifacts (pure data, no filesystem writes). */
  generate(pack: CanonicalPack, context: AdapterContext): Promise<GeneratedArtifact[]>;

  /** Convert artifacts into installer operations with absolute paths. */
  planInstall(
    artifacts: GeneratedArtifact[],
    context: InstallContext,
  ): Promise<InstallOperationLike[]>;

  /** Optional importer: read native config into canonical form. */
  import?(context: ImportContext): Promise<ImportedConfiguration>;

  /** Paths (files or dirs) that collect mode should watch for native changes. */
  nativeSources?(context: ImportContext): Promise<string[]>;
}

/**
 * Structural mirror of the filesystem package's InstallOperation, kept here
 * so the adapter contract does not depend on the filesystem package.
 * The installer validates these before applying.
 */
export type InstallOperationLike =
  | { type: "writeFile"; path: string; content: string; executable?: boolean }
  | { type: "mergeJson"; path: string; pointer: string; value: unknown }
  | { type: "mergeToml"; path: string; table: string[]; value: unknown }
  | {
      type: "managedMarkdownSection";
      path: string;
      sectionId: string;
      content: string;
      append?: boolean;
    }
  | { type: "createSymlink"; path: string; target: string }
  | { type: "copyDirectory"; source: string; dest: string }
  | { type: "removeOwnedPath"; path: string };

/* --------------------------- Helper utilities ------------------------ */

/** Render an EnvValue map to plain strings with `${VAR}` references. */
export function renderEnvRecord(
  record: Record<string, EnvValue> | undefined,
  formatRef: (varName: string) => string = (name) => `\${${name}}`,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if ("value" in value) out[key] = value.value;
    else if ("fromEnv" in value) out[key] = formatRef(value.fromEnv);
    else {
      out[key] = value.template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) =>
        formatRef(name),
      );
    }
  }
  return out;
}
