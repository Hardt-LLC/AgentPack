import path from "node:path";
import { listBackups, restoreBackup } from "@agentpack/filesystem";

export interface RollbackResult {
  backupId: string;
  restored: string[];
}

export interface BackupInfo {
  id: string;
  createdAt: string;
}

/** List available backups, newest first. */
export async function listAvailableBackups(workspaceRoot: string): Promise<BackupInfo[]> {
  const backupsDir = path.join(workspaceRoot, ".agentpack", "backups");
  const backups = await listBackups(backupsDir);
  return backups.map((b) => ({ id: b.id, createdAt: b.createdAt }));
}

/**
 * Restore a previous AgentPack-managed state. Without `to`, restores the
 * most recent backup.
 */
export async function rollback(workspaceRoot: string, to?: string): Promise<RollbackResult> {
  const backupsDir = path.join(workspaceRoot, ".agentpack", "backups");
  const backups = await listBackups(backupsDir);
  if (backups.length === 0) throw new Error("no backups available");
  const selected = to ? backups.find((b) => b.id === to) : backups[0];
  if (!selected) {
    throw new Error(`backup not found: ${to} (available: ${backups.map((b) => b.id).join(", ")})`);
  }
  const restored = await restoreBackup(selected.dir);
  return { backupId: selected.id, restored };
}
