import path from "node:path";

import type { Diagnostic, TargetId } from "@agentpack/schema";
import { createBackup, readFileIfExists, writeFileAtomic } from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

/**
 * Claude SessionStart collect hook: appends a hook entry to the user-scope
 * claude settings so every agent session start runs
 * `agentpack collect --from claude --quiet`, feeding newly collected items
 * into the session context. This is a different domain from pack hooks
 * (pack.yaml lifecycle hooks), hence the separate module name.
 */

export interface CollectHookOptions {
  target: TargetId;
  cliPath: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export interface InstallCollectHookResult {
  path: string;
  installed: boolean;
  message: string;
  diagnostics: Diagnostic[];
}

export interface UninstallCollectHookResult {
  removed: boolean;
  diagnostics: Diagnostic[];
}

/** Marker that identifies AgentPack's collect entries in settings.json. */
const COLLECT_MARKER = "collect --from";

interface SessionStartEntry {
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
  [key: string]: unknown;
}

function settingsPath(homeDir: string): string {
  return path.join(homeDir, ".claude", "settings.json");
}

function entryCommands(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const hooks = (entry as SessionStartEntry).hooks;
  if (!Array.isArray(hooks)) return [];
  return hooks.flatMap((hook) => (typeof hook?.command === "string" ? [hook.command] : []));
}

async function readSettings(
  filePath: string,
): Promise<{ doc: Record<string, unknown>; existed: boolean }> {
  const raw = await readFileIfExists(filePath);
  if (raw === undefined) return { doc: {}, existed: false };
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`claude settings file is not a JSON object: ${filePath}`);
  }
  return { doc: parsed as Record<string, unknown>, existed: true };
}

async function writeSettings(
  workspace: LoadWorkspaceResult,
  filePath: string,
  existed: boolean,
  doc: Record<string, unknown>,
): Promise<void> {
  if (existed) {
    const backupsDir = path.join(workspace.rootDir, ".agentpack", "backups");
    await createBackup(backupsDir, [filePath], "collect-hook");
  }
  await writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
}

function unsupportedResult(target: TargetId, settingsFile: string): InstallCollectHookResult {
  return {
    path: settingsFile,
    installed: false,
    message: `target "${target}" has no hook system`,
    diagnostics: [{ severity: "warning", message: `target "${target}" has no hook system` }],
  };
}

/**
 * Install the SessionStart collect hook into the user-scope claude settings.
 * Idempotent: an existing entry whose command contains "collect --from" is
 * left untouched, and the user's other hooks are never removed or reordered.
 */
export async function installCollectHook(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: CollectHookOptions,
): Promise<InstallCollectHookResult> {
  registry.get(opts.target); // throws a clear error for unknown targets
  const homeDir = opts.homeDir ?? opts.env?.HOME ?? process.env.HOME ?? "";
  const filePath = settingsPath(homeDir);
  if (opts.target !== "claude") return unsupportedResult(opts.target, filePath);

  const command = [
    process.execPath,
    opts.cliPath,
    "collect",
    "--from",
    "claude",
    "--quiet",
    "--workspace",
    workspace.rootDir,
  ].join(" ");

  const { doc, existed } = await readSettings(filePath);
  const hooks =
    typeof doc.hooks === "object" && doc.hooks !== null && !Array.isArray(doc.hooks)
      ? (doc.hooks as Record<string, unknown>)
      : {};
  const sessionStart: unknown[] = Array.isArray(hooks.SessionStart)
    ? (hooks.SessionStart as unknown[])
    : [];
  const alreadyInstalled = sessionStart.some((entry) =>
    entryCommands(entry).some((cmd) => cmd.includes(COLLECT_MARKER)),
  );
  if (alreadyInstalled) {
    return {
      path: filePath,
      installed: false,
      message: `collect hook already present in ${filePath}`,
      diagnostics: [],
    };
  }

  sessionStart.push({ hooks: [{ type: "command", command, timeout: 30 }] });
  hooks.SessionStart = sessionStart;
  doc.hooks = hooks;
  await writeSettings(workspace, filePath, existed, doc);
  return {
    path: filePath,
    installed: true,
    message: `installed SessionStart collect hook in ${filePath}`,
    diagnostics: [],
  };
}

/**
 * Remove AgentPack's collect entries from the SessionStart array (deleting
 * the array when it becomes empty). Everything else is left as-is.
 */
export async function uninstallCollectHook(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: Omit<CollectHookOptions, "cliPath">,
): Promise<UninstallCollectHookResult> {
  registry.get(opts.target);
  if (opts.target !== "claude") {
    return {
      removed: false,
      diagnostics: [{ severity: "warning", message: `target "${opts.target}" has no hook system` }],
    };
  }
  const homeDir = opts.homeDir ?? opts.env?.HOME ?? process.env.HOME ?? "";
  const filePath = settingsPath(homeDir);
  const { doc, existed } = await readSettings(filePath);
  const hooks =
    typeof doc.hooks === "object" && doc.hooks !== null && !Array.isArray(doc.hooks)
      ? (doc.hooks as Record<string, unknown>)
      : undefined;
  if (!hooks || !Array.isArray(hooks.SessionStart)) {
    return { removed: false, diagnostics: [] };
  }

  const before = hooks.SessionStart as unknown[];
  const kept = before.filter(
    (entry) => !entryCommands(entry).some((cmd) => cmd.includes(COLLECT_MARKER)),
  );
  if (kept.length === before.length) {
    return { removed: false, diagnostics: [] };
  }
  if (kept.length === 0) delete hooks.SessionStart;
  else hooks.SessionStart = kept;
  await writeSettings(workspace, filePath, existed, doc);
  return { removed: true, diagnostics: [] };
}
