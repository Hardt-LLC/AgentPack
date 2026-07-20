import type { HookSpec, McpServerSpec, PackManifest, PluginSpec } from "./pack.js";
import type { TargetId } from "./targets.js";

/**
 * Canonical intermediate representation (IR).
 *
 * Adapters never read YAML — they consume these normalized in-memory
 * structures produced by the core loader.
 */

export interface PackMetadata {
  name: string;
  version: string;
  description?: string;
  license?: string;
  keywords?: string[];
}

/** A loaded, validated Agent Skill directory. */
export interface CanonicalSkill {
  /** Skill name, equal to its directory name. */
  name: string;
  description: string;
  /** Absolute path of the skill root directory (contains SKILL.md). */
  rootDir: string;
  /** All files below rootDir, POSIX-style relative paths, sorted. */
  files: string[];
  /** Parsed YAML frontmatter of SKILL.md (including name/description). */
  frontmatter: Record<string, unknown>;
}

export interface CanonicalInstruction {
  id: string;
  /** Absolute path of the source markdown file. */
  sourcePath: string;
  /** Markdown body. */
  content: string;
  scope: "global" | "project" | "directory";
  directory?: string;
  priority: number;
  mergeStrategy: "managed-section" | "append";
  targets?: TargetId[];
}

export type CanonicalMcpServer = McpServerSpec & { name: string };

export type CanonicalHook = HookSpec;

export type CanonicalPlugin = PluginSpec;

export interface CanonicalPack {
  metadata: PackMetadata;
  /** Absolute path of the pack root (directory containing pack.yaml). */
  rootDir: string;
  skills: CanonicalSkill[];
  instructions: CanonicalInstruction[];
  mcpServers: Record<string, CanonicalMcpServer>;
  hooks: CanonicalHook[];
  plugin?: CanonicalPlugin;
  /** Raw per-target extension data from spec.extensions.<target>. */
  targetExtensions: Partial<Record<TargetId, Record<string, unknown>>>;
  /** Per-target enablement from spec.targets (default: enabled). */
  targetEnabled: Partial<Record<TargetId, boolean>>;
}

/** A fully loaded workspace: manifest + resolved packs. */
export interface LoadedWorkspace {
  /** Absolute path of the workspace root (directory containing agentpack.yaml). */
  rootDir: string;
  manifest: import("./pack.js").WorkspaceManifest;
  packs: CanonicalPack[];
}

export type { PackManifest };
