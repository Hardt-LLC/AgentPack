import path from "node:path";
import { promises as fs } from "node:fs";
import { TARGET_IDS, type Diagnostic, type TargetId } from "@agentpack/schema";
import {
  getJsonAtPointer,
  getTomlAtTable,
  loadState,
  mergeJsonAtPointer,
  mergeTomlAtTable,
  pathExists,
  readFileIfExists,
  saveState,
  writeFileAtomic,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { removePack } from "./remove.js";
import { uninstallGateway } from "./gateway.js";
import type { SelectionOverrides } from "./profiles.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface UninstallResult {
  target: TargetId | "all";
  removedOwned: string[];
  restoredKeys: string[];
  restoredPaths: string[];
  skipped: Array<{ path: string; reason: string }>;
  diagnostics: Diagnostic[];
  dryRun: boolean;
}

export interface UninstallOptions extends SelectionOverrides {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  dryRun?: boolean;
}

interface BackupManifest {
  id: string;
  createdAt: string;
  entries: Array<{ originalPath: string; storedPath: string; existed: boolean }>;
}

/** Restore one adopted path from the backup that captured it. */
async function restoreAdoptedPath(
  workspaceRoot: string,
  backupId: string,
  originalPath: string,
): Promise<void> {
  const manifestPath = path.join(workspaceRoot, ".agentpack", "backups", backupId, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as BackupManifest;
  const entry = manifest.entries.find((e) => e.originalPath === originalPath);
  if (!entry || !entry.existed)
    throw new Error(`backup ${backupId} has no entry for ${originalPath}`);
  const stored = path.join(workspaceRoot, ".agentpack", "backups", backupId, entry.storedPath);
  const stat = await fs.stat(stored);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.cp(stored, originalPath, { recursive: stat.isDirectory() });
}

/**
 * Fully uninstall AgentPack from the selected targets: remove everything it
 * owns (files, config keys, the gateway entry), then restore every adopted
 * (pre-AgentPack) config key and path. Unmanaged content is never touched.
 */
export async function uninstallWorkspace(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: UninstallOptions = {},
): Promise<UninstallResult> {
  const diagnostics: Diagnostic[] = [];
  const removedOwned: string[] = [];
  const restoredKeys: string[] = [];
  const restoredPaths: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const state = await loadState(workspace.rootDir);
  const targets: TargetId[] = opts.targets ?? TARGET_IDS.filter((t) => registry.has(t));

  // 1. Remove owned items pack by pack (existing, checksum-guarded logic).
  for (const loaded of workspace.packs) {
    const name = loaded.pack?.metadata.name;
    if (!name) continue;
    const result = await removePack(workspace, registry, name, {
      target: opts.targets?.[0],
      scope: opts.scope,
      dryRun: opts.dryRun,
      env: opts.env,
      homeDir: opts.homeDir,
    });
    removedOwned.push(...result.removed);
    skipped.push(...result.skipped);
    diagnostics.push(...result.diagnostics);
  }

  // 2. Remove the gateway entry.
  const gw = await uninstallGateway(workspace, registry, {
    targets: opts.targets,
    scope: opts.scope,
    env: opts.env,
    homeDir: opts.homeDir,
  });
  if (!opts.dryRun) removedOwned.push(...gw.removed);
  diagnostics.push(...gw.diagnostics);

  if (opts.dryRun) {
    for (const target of targets) {
      const adopted = state.targets[target]?.adopted;
      for (const key of adopted?.configKeys ?? []) {
        restoredKeys.push(`${key.path} ${key.jsonPointer ?? key.tomlTable?.join(".")}`);
      }
      for (const p of adopted?.paths ?? []) restoredPaths.push(p.path);
    }
    return {
      target: opts.targets?.[0] ?? "all",
      removedOwned,
      restoredKeys,
      restoredPaths,
      skipped,
      diagnostics,
      dryRun: true,
    };
  }

  // 3. Restore adopted config keys (only when the key is absent now).
  // Reload state: removePack and uninstallGateway saved their own updates.
  const freshState = await loadState(workspace.rootDir);
  for (const target of targets) {
    const targetState = freshState.targets[target];
    const adopted = targetState?.adopted;
    if (!adopted) continue;
    for (const key of adopted.configKeys) {
      const raw = await readFileIfExists(key.path);
      try {
        // Restore only when the key is absent: a foreign same-name key is
        // left alone and reported, never overwritten.
        const current = key.tomlTable
          ? getTomlAtTable(raw ?? "", key.tomlTable)
          : raw === undefined
            ? undefined
            : getJsonAtPointer(raw, key.jsonPointer!);
        if (current !== undefined) {
          skipped.push({
            path: key.path,
            reason: `key ${key.jsonPointer ?? key.tomlTable?.join(".")} exists and is not AgentPack-owned; left in place`,
          });
          continue;
        }
        const next = key.tomlTable
          ? mergeTomlAtTable(raw, key.tomlTable, key.value)
          : mergeJsonAtPointer(raw, key.jsonPointer!, key.value);
        await writeFileAtomic(key.path, next);
        restoredKeys.push(`${key.path} ${key.jsonPointer ?? key.tomlTable?.join(".")}`);
      } catch (error) {
        skipped.push({ path: key.path, reason: `cannot restore key: ${(error as Error).message}` });
      }
    }
    // 4. Restore adopted paths from their backups.
    for (const p of adopted.paths) {
      if (await pathExists(p.path)) {
        skipped.push({
          path: p.path,
          reason: "path exists and is not AgentPack-owned; left in place",
        });
        continue;
      }
      try {
        await restoreAdoptedPath(workspace.rootDir, p.backupId, p.path);
        restoredPaths.push(p.path);
      } catch (error) {
        skipped.push({ path: p.path, reason: `cannot restore: ${(error as Error).message}` });
      }
    }
    adopted.configKeys = adopted.configKeys.filter(
      (k) => !restoredKeys.some((r) => r.startsWith(k.path)),
    );
    adopted.paths = adopted.paths.filter((p) => !restoredPaths.includes(p.path));
  }

  await saveState(workspace.rootDir, freshState);
  return {
    target: opts.targets?.[0] ?? "all",
    removedOwned,
    restoredKeys,
    restoredPaths,
    skipped,
    diagnostics,
    dryRun: false,
  };
}
