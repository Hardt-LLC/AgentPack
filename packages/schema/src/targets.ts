import { z } from "zod";

/** Known target agent identifiers. */
export const targetIdSchema = z.enum([
  "codex",
  "claude",
  "kimi",
  "cursor",
  "windsurf",
  "cline",
  "roo",
  "kilo",
  "copilot-vscode",
  "copilot-cli",
  "gemini",
  "antigravity",
  "opencode",
  "openclaw",
  "pi",
  "hermes",
  "vibe",
  "droid",
]);
export type TargetId = z.infer<typeof targetIdSchema>;
export const TARGET_IDS: readonly TargetId[] = [
  "codex",
  "claude",
  "kimi",
  "cursor",
  "windsurf",
  "cline",
  "roo",
  "kilo",
  "copilot-vscode",
  "copilot-cli",
  "gemini",
  "antigravity",
  "opencode",
  "openclaw",
  "pi",
  "hermes",
  "vibe",
  "droid",
];

/** How well a target supports a component. */
export type CapabilitySupport = "native" | "transpiled" | "degraded" | "unsupported";

export const componentTypeSchema = z.enum([
  "skill",
  "mcp",
  "instruction",
  "plugin",
  "hook",
  "agent",
]);
export type ComponentType = z.infer<typeof componentTypeSchema>;

export interface CapabilityFinding {
  target: TargetId;
  componentType: ComponentType;
  componentId: string;
  support: CapabilitySupport;
  message?: string;
  remediation?: string;
}

export interface CapabilityReport {
  findings: CapabilityFinding[];
}

/** How capability problems are treated. */
export type Strictness = "permissive" | "strict" | "portable";
export const STRICTNESS_LEVELS: readonly Strictness[] = ["permissive", "strict", "portable"];

export type Scope = "project" | "user";
export const SCOPES: readonly Scope[] = ["project", "user"];

export type InstallMode = "auto" | "symlink" | "copy";
export const INSTALL_MODES: readonly InstallMode[] = ["auto", "symlink", "copy"];

/** A single diagnostic produced by validation, planning or synchronization. */
export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** Optional file or component the diagnostic refers to. */
  source?: string;
}

export function diagnosticsHaveErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
