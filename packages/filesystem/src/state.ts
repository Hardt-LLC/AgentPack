import path from "node:path";

import { ensureDir, readFileIfExists, writeFileAtomic } from "./atomic.js";
import { sha256 } from "./hash.js";

export interface OwnedFile {
  path: string;
  type: "file" | "symlink" | "directory";
  checksum: string;
}

export interface OwnedConfigKey {
  path: string;
  jsonPointer?: string;
  tomlTable?: string[];
  checksum: string;
}

export interface TargetState {
  ownedFiles: OwnedFile[];
  ownedConfigKeys: OwnedConfigKey[];
  /**
   * Pre-AgentPack configuration adopted during onboarding. Recorded so
   * `agentpack uninstall` can restore the exact original state.
   */
  adopted?: {
    /** Config keys that were removed from native files (values kept inline). */
    configKeys: Array<{
      path: string;
      jsonPointer?: string;
      tomlTable?: string[];
      value: unknown;
      checksum: string;
    }>;
    /** Filesystem paths moved aside into a backup before AgentPack took their place. */
    paths: Array<{ path: string; type: "file" | "directory"; backupId: string }>;
  };
}

export interface SyncState {
  version: 1;
  workspaceId: string;
  lastSyncAt: string | null;
  targets: Record<string, TargetState>;
  /** Trust grants keyed by pack name. */
  trust?: Record<string, { contentHash: string; grantedAt: string }>;
}

/** Create an empty sync state for a workspace. */
export function emptyState(workspaceId: string): SyncState {
  return { version: 1, workspaceId, lastSyncAt: null, targets: {} };
}

/**
 * Compute a stable workspace id from the agentpack.yaml content only, so
 * moving the workspace directory does not invalidate it.
 */
export function computeWorkspaceId(workspaceRoot: string, agentpackYamlContent: string): string {
  void workspaceRoot;
  return sha256(agentpackYamlContent);
}

function statePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agentpack", "state.json");
}

/**
 * Load the sync state from `<workspaceRoot>/.agentpack/state.json`.
 * Returns an empty state (with a computed workspace id) when the file is
 * missing; throws on corrupt JSON.
 */
export async function loadState(workspaceRoot: string): Promise<SyncState> {
  const filePath = statePath(workspaceRoot);
  const content = await readFileIfExists(filePath);
  if (content === undefined) {
    const yaml =
      (await readFileIfExists(path.join(workspaceRoot, "agentpack.yaml"))) ??
      (await readFileIfExists(path.join(workspaceRoot, "agentpack.yml"))) ??
      "";
    return emptyState(computeWorkspaceId(workspaceRoot, yaml));
  }
  try {
    return JSON.parse(content) as SyncState;
  } catch (err) {
    throw new Error(`corrupt state file at ${filePath}: ${(err as Error).message}`);
  }
}

/** Persist the sync state atomically, creating `.agentpack/` as needed. */
export async function saveState(workspaceRoot: string, state: SyncState): Promise<void> {
  const filePath = statePath(workspaceRoot);
  await ensureDir(path.dirname(filePath));
  await writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}
