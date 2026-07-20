import { promises as fs } from "node:fs";
import path from "node:path";
import { TARGET_IDS, type Diagnostic, type TargetId } from "@agentpack/schema";
import {
  applyOperations,
  createBackup,
  getJsonAtPointer,
  getTomlAtTable,
  hashDirectory,
  hashFile,
  isSymlink,
  loadState,
  pathExists,
  pruneBackups,
  saveState,
  sha256,
  withProcessLock,
  type InstallOperation,
  type OwnedConfigKey,
  type OwnedFile,
  type SyncState,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { buildPlan, type PlanOptions, type SyncPlan } from "./plan.js";
import { detectTargets, type DetectedTargets } from "./detect.js";
import { evaluateTrust, formatTrustSummary, type TrustRefusal } from "./trust.js";
import { adoptPathIfNeeded, type PathAdoption } from "./adopt.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface Conflict {
  target: TargetId;
  path: string;
  reason: string;
}

export interface SyncResult {
  plan: SyncPlan;
  applied: boolean;
  dryRun: boolean;
  conflicts: Conflict[];
  trustRefusals: TrustRefusal[];
  backupId?: string;
  /** Unmanaged paths adopted (moved to backup) during this sync. */
  adoptions?: PathAdoption[];
  diagnostics: Diagnostic[];
}

export interface SyncOptions extends PlanOptions {
  dryRun?: boolean;
  force?: boolean;
  /** Pack names explicitly trusted for this run (`--trust`). */
  trust?: string[];
  /**
   * Adopt unmanaged paths that stand where AgentPack needs to create:
   * they are moved into a backup and recorded for uninstall restoration.
   */
  adopt?: boolean;
}

/** Deterministic JSON with sorted keys, for checksums of merged values. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical form of a managed markdown section body (trailing whitespace). */
export function normalizeSectionBody(content: string): string {
  return content.replace(/\s+$/u, "") + "\n";
}

export function valueChecksum(value: unknown): string {
  return sha256(stableStringify(value));
}

async function currentFileChecksum(p: string): Promise<string | undefined> {
  if (!(await pathExists(p)) && !(await isSymlink(p))) return undefined;
  if (await isSymlink(p)) {
    const target = await fs.readlink(p);
    return sha256(`symlink:${target}`);
  }
  const stat = await fs.stat(p);
  if (stat.isDirectory()) return hashDirectory(p);
  return hashFile(p);
}

const MARKDOWN_POINTER_PREFIX = "#markdown:";

function opConfigKey(
  op: InstallOperation,
): { path: string; pointer?: string; tomlTable?: string[]; value: unknown } | undefined {
  if (op.type === "mergeJson") return { path: op.path, pointer: op.pointer, value: op.value };
  if (op.type === "mergeToml") return { path: op.path, tomlTable: op.table, value: op.value };
  if (op.type === "managedMarkdownSection") {
    return {
      path: op.path,
      pointer: MARKDOWN_POINTER_PREFIX + op.sectionId,
      value: normalizeSectionBody(op.content),
    };
  }
  return undefined;
}

function sameKey(
  key: OwnedConfigKey,
  candidate: { path: string; pointer?: string; tomlTable?: string[] },
): boolean {
  if (key.path !== candidate.path) return false;
  if (key.tomlTable || candidate.tomlTable) {
    return JSON.stringify(key.tomlTable) === JSON.stringify(candidate.tomlTable);
  }
  return key.jsonPointer === candidate.pointer;
}

/** Compare recorded ownership against the live filesystem. */
export async function detectConflicts(
  state: SyncState,
  target: TargetId,
  desiredOps: InstallOperation[],
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  const targetState = state.targets[target];
  if (!targetState) return conflicts;

  const desiredFileChecksums = new Map<string, string>();
  for (const op of desiredOps) {
    if (op.type === "writeFile") desiredFileChecksums.set(op.path, sha256(op.content));
    if (op.type === "createSymlink")
      desiredFileChecksums.set(op.path, sha256(`symlink:${op.target}`));
    if (op.type === "copyDirectory")
      desiredFileChecksums.set(op.dest, await hashDirectory(op.source));
  }
  const desiredKeys = desiredOps.map(opConfigKey).filter((k) => k !== undefined);

  for (const owned of targetState.ownedFiles) {
    const current = await currentFileChecksum(owned.path);
    if (current === undefined || current === owned.checksum) continue;
    const desired = desiredFileChecksums.get(owned.path);
    if (desired !== undefined && desired === current) continue; // already at desired state
    conflicts.push({
      target,
      path: owned.path,
      reason: "file was modified externally since the last sync",
    });
  }

  for (const key of targetState.ownedConfigKeys) {
    let current: unknown;
    try {
      const raw = await fs.readFile(key.path, "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      if (key.tomlTable) current = getTomlAtTable(raw, key.tomlTable);
      else if (key.jsonPointer?.startsWith(MARKDOWN_POINTER_PREFIX)) {
        const { sectionContent } = await import("@agentpack/filesystem");
        const body = sectionContent(raw, key.jsonPointer.slice(MARKDOWN_POINTER_PREFIX.length));
        current = body === undefined ? undefined : normalizeSectionBody(body);
      } else if (key.jsonPointer) current = getJsonAtPointer(raw, key.jsonPointer);
    } catch {
      continue; // unreadable/unparseable — plan phase reports it
    }
    if (current === undefined) continue;
    const currentChecksum = valueChecksum(current);
    if (currentChecksum === key.checksum) continue;
    const desired = desiredKeys.find((d) => sameKey(key, d));
    if (desired && valueChecksum(desired.value) === currentChecksum) continue; // already at desired state
    conflicts.push({
      target,
      path: key.path,
      reason: `configuration key ${key.jsonPointer ?? key.tomlTable?.join(".")} was modified externally since the last sync`,
    });
  }
  return conflicts;
}

function desiredChecksumOf(op: InstallOperation): string | undefined {
  if (op.type === "writeFile") return sha256(op.content);
  return undefined; // copyDirectory: source hash compared inside adoptPathIfNeeded
}

/**
 * Synchronize standalone components to the selected targets.
 * Idempotent, locked, backed-up, conflict-aware.
 */
export async function syncWorkspace(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const diagnostics: Diagnostic[] = [];
  const detected: DetectedTargets = await detectTargets(registry, workspace.rootDir, {
    env: opts.env,
    homeDir: opts.homeDir,
  });
  const state = await loadState(workspace.rootDir);
  const plan = await buildPlan(workspace, registry, detected, { ...opts, state });
  diagnostics.push(...plan.diagnostics);

  if (plan.diagnostics.some((d) => d.severity === "error")) {
    return {
      plan,
      applied: false,
      dryRun: opts.dryRun === true,
      conflicts: [],
      trustRefusals: [],
      diagnostics,
    };
  }

  // Trust gate — refuses before touching anything.
  const { refusals, newlyTrusted } = await evaluateTrust(
    plan.selection.packs,
    state.trust,
    opts.trust ?? [],
  );
  if (refusals.length > 0) {
    for (const refusal of refusals) {
      diagnostics.push({
        severity: "error",
        message: `trust refusal: ${refusal.reason}\n${formatTrustSummary(refusal.requirement)}\nRe-run with: agentpack sync --trust ${refusal.requirement.pack}`,
      });
    }
    return {
      plan,
      applied: false,
      dryRun: opts.dryRun === true,
      conflicts: [],
      trustRefusals: refusals,
      diagnostics,
    };
  }

  // Conflicts.
  const conflicts: Conflict[] = [];
  for (const targetPlan of plan.targets) {
    const ops = targetPlan.operations.map((p) => p.operation);
    conflicts.push(...(await detectConflicts(state, targetPlan.target, ops)));
    for (const removal of targetPlan.removals) {
      if (removal.action === "noop") continue;
      const p = removal.operation.type === "removeOwnedPath" ? removal.operation.path : "";
      const owned = state.targets[targetPlan.target]?.ownedFiles.find((f) => f.path === p);
      const current = p ? await currentFileChecksum(p) : undefined;
      if (owned && current && current !== owned.checksum) {
        conflicts.push({
          target: targetPlan.target,
          path: p,
          reason: "owned path was modified externally; refusing to remove it",
        });
      }
    }
  }
  if (conflicts.length > 0 && !opts.force) {
    return {
      plan,
      applied: false,
      dryRun: opts.dryRun === true,
      conflicts,
      trustRefusals: [],
      diagnostics,
    };
  }

  if (opts.dryRun) {
    return { plan, applied: false, dryRun: true, conflicts, trustRefusals: [], diagnostics };
  }

  const lockPath = path.join(workspace.rootDir, ".agentpack", "agentpack.lock");
  let backupId: string | undefined;
  const adoptions: PathAdoption[] = [];

  await withProcessLock(lockPath, async () => {
    const toApply: InstallOperation[] = [];
    const changedTargets = new Set<TargetId>();
    const backupsDir = path.join(workspace.rootDir, ".agentpack", "backups");
    const pathsToBackup: string[] = [];

    for (const targetPlan of plan.targets) {
      const active = targetPlan.operations.filter((p) => p.action !== "noop");
      const removals = targetPlan.removals
        .filter((p) => p.action !== "noop")
        .map((p) => p.operation);
      if (active.length === 0 && removals.length === 0) continue;
      changedTargets.add(targetPlan.target);
      for (const planned of active) {
        // Adopt unmanaged paths standing where we need to create.
        if (opts.adopt && planned.action !== "noop") {
          const op = planned.operation;
          if (
            op.type === "createSymlink" ||
            op.type === "copyDirectory" ||
            op.type === "writeFile"
          ) {
            const owned = state.targets[targetPlan.target]?.ownedFiles.some(
              (f) => f.path === (op.type === "copyDirectory" ? op.dest : op.path),
            );
            if (!owned) {
              const adopted = await adoptPathIfNeeded(
                workspace.rootDir,
                targetPlan.target,
                op,
                desiredChecksumOf(op),
                state,
              );
              if (adopted) adoptions.push(adopted);
            }
          }
        }
        toApply.push(planned.operation);
        const p =
          planned.operation.type === "copyDirectory"
            ? planned.operation.dest
            : planned.operation.type === "removeOwnedPath"
              ? ""
              : planned.operation.path;
        if (p && (await pathExists(p))) pathsToBackup.push(p);
      }
      toApply.push(...removals);
      for (const removal of removals) {
        if (removal.type === "removeOwnedPath" && (await pathExists(removal.path))) {
          pathsToBackup.push(removal.path);
        }
      }
    }

    if (toApply.length > 0) {
      const backup = await createBackup(backupsDir, [...new Set(pathsToBackup)], "sync");
      backupId = backup.id;

      const ownedPaths = new Set(
        Object.values(state.targets).flatMap((t) => t.ownedFiles.map((f) => f.path)),
      );
      await applyOperations(toApply, { guardRemove: (p) => ownedPaths.has(p) });

      // Rebuild ownership for changed targets.
      for (const targetPlan of plan.targets) {
        if (!changedTargets.has(targetPlan.target)) continue;
        const ownedFiles: OwnedFile[] = [];
        const ownedConfigKeys: OwnedConfigKey[] = [];
        for (const planned of targetPlan.operations) {
          const op = planned.operation;
          if (op.type === "writeFile") {
            ownedFiles.push({ path: op.path, type: "file", checksum: sha256(op.content) });
          } else if (op.type === "createSymlink") {
            ownedFiles.push({
              path: op.path,
              type: "symlink",
              checksum: sha256(`symlink:${op.target}`),
            });
          } else if (op.type === "copyDirectory") {
            ownedFiles.push({
              path: op.dest,
              type: "directory",
              checksum: await hashDirectory(op.dest),
            });
          } else {
            const key = opConfigKey(op);
            if (key) {
              ownedConfigKeys.push({
                path: key.path,
                jsonPointer: key.pointer,
                tomlTable: key.tomlTable,
                checksum: valueChecksum(key.value),
              });
            }
          }
        }
        state.targets[targetPlan.target] = {
          ...state.targets[targetPlan.target],
          ownedFiles,
          ownedConfigKeys,
        };
      }
      state.lastSyncAt = new Date().toISOString();
    }

    // Record newly granted trust decisions.
    if (newlyTrusted.length > 0) {
      state.trust = state.trust ?? {};
      for (const req of newlyTrusted) {
        state.trust[req.pack] = {
          contentHash: req.contentHash,
          grantedAt: new Date().toISOString(),
        };
      }
    }

    await saveState(workspace.rootDir, state);
    await pruneBackups(backupsDir, 10).catch(() => undefined);
  });

  return {
    plan,
    applied: true,
    dryRun: false,
    conflicts,
    trustRefusals: [],
    backupId,
    adoptions,
    diagnostics,
  };
}

export { TARGET_IDS as ALL_TARGETS };
