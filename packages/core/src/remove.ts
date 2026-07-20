import { promises as fs } from "node:fs";
import {
  TARGET_IDS,
  type Diagnostic,
  type GeneratedArtifact,
  type TargetId,
} from "@agentpack/schema";
import {
  createBackup,
  getJsonAtPointer,
  getTomlAtTable,
  hashDirectory,
  isSymlink,
  loadState,
  pathExists,
  readFileIfExists,
  removeDirectoryRecursive,
  removeJsonAtPointer,
  removeManagedSection,
  removeTomlAtTable,
  saveState,
  sectionContent,
  sha256,
  writeFileAtomic,
  type InstallOperation,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { buildAdapterContext, detectTargets } from "./detect.js";
import { stableStringify, normalizeSectionBody } from "./sync.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface RemoveResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  diagnostics: Diagnostic[];
  backupId?: string;
  dryRun: boolean;
}

export interface RemoveOptions {
  target?: TargetId;
  scope?: "project" | "user";
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

const MARKDOWN_POINTER_PREFIX = "#markdown:";

async function currentChecksum(p: string): Promise<string | undefined> {
  if (await isSymlink(p)) return sha256(`symlink:${await fs.readlink(p)}`);
  if (!(await pathExists(p))) return undefined;
  const stat = await fs.stat(p);
  return stat.isDirectory() ? hashDirectory(p) : sha256(await fs.readFile(p, "utf8"));
}

async function deletePath(p: string): Promise<void> {
  if (await isSymlink(p)) {
    await fs.unlink(p);
    return;
  }
  const stat = await fs.stat(p).catch(() => undefined);
  if (!stat) return;
  if (stat.isDirectory()) await removeDirectoryRecursive(p);
  else await fs.unlink(p);
}

/**
 * Remove everything a pack owns on the selected targets — and nothing else.
 * Ownership is verified against state.json checksums before deleting.
 */
export async function removePack(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  packName: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const diagnostics: Diagnostic[] = [];
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const pack = workspace.packs.find((p) => p.pack?.metadata.name === packName)?.pack;
  if (!pack) {
    diagnostics.push({ severity: "error", message: `pack not found: ${packName}` });
    return { removed, skipped, diagnostics, dryRun: opts.dryRun === true };
  }

  const state = await loadState(workspace.rootDir);
  const detected = await detectTargets(registry, workspace.rootDir, {
    env: opts.env,
    homeDir: opts.homeDir,
  });
  // Default to the default profile's scope (sync installs there) before
  // falling back to project scope.
  const scope = opts.scope ?? workspace.manifest?.profiles?.["default"]?.scope ?? "project";
  const targets: TargetId[] = opts.target
    ? [opts.target]
    : TARGET_IDS.filter((t) => registry.has(t));

  interface FileRemoval {
    kind: "path";
    path: string;
    pointer?: undefined;
    tomlTable?: undefined;
    sectionId?: undefined;
  }
  interface KeyRemoval {
    kind: "json" | "toml" | "markdown";
    path: string;
    pointer?: string;
    tomlTable?: string[];
    sectionId?: string;
  }
  type PendingRemoval = (FileRemoval | KeyRemoval) & { target: TargetId };
  const pending: PendingRemoval[] = [];

  for (const target of targets) {
    const adapter = registry.get(target);
    if (pack.targetEnabled[target] === false) continue;
    const targetState = state.targets[target];
    if (!targetState) continue;

    const context = buildAdapterContext(
      adapter,
      detected[target],
      scope,
      workspace.rootDir,
      opts.env ?? process.env,
      { homeDir: opts.homeDir },
    );
    const artifacts: GeneratedArtifact[] = await adapter.generate(pack, context);
    const ops = (await adapter.planInstall(artifacts, {
      ...context,
      installMode: "copy",
      symlinksReliable: false,
    })) as InstallOperation[];

    for (const op of ops) {
      if (op.type === "writeFile" || op.type === "createSymlink" || op.type === "copyDirectory") {
        const p = op.type === "copyDirectory" ? op.dest : op.path;
        const owned = targetState.ownedFiles.find((f) => f.path === p);
        if (!owned) {
          skipped.push({ path: p, reason: "not owned by AgentPack" });
          continue;
        }
        const current = await currentChecksum(p);
        if (current === undefined) continue; // already gone
        if (current !== owned.checksum) {
          skipped.push({ path: p, reason: "modified externally; refusing to remove" });
          continue;
        }
        pending.push({ kind: "path", path: p, target });
        continue;
      }

      if (
        op.type === "mergeJson" ||
        op.type === "mergeToml" ||
        op.type === "managedMarkdownSection"
      ) {
        const pointer =
          op.type === "mergeJson"
            ? op.pointer
            : op.type === "managedMarkdownSection"
              ? MARKDOWN_POINTER_PREFIX + op.sectionId
              : undefined;
        const tomlTable = op.type === "mergeToml" ? op.table : undefined;
        const owned = targetState.ownedConfigKeys.find(
          (k) =>
            k.path === op.path &&
            k.jsonPointer === pointer &&
            JSON.stringify(k.tomlTable) === JSON.stringify(tomlTable),
        );
        if (!owned) {
          skipped.push({ path: op.path, reason: "config key not owned by AgentPack" });
          continue;
        }
        const raw = await readFileIfExists(op.path);
        if (raw === undefined) continue;
        let current: unknown;
        try {
          if (tomlTable) current = getTomlAtTable(raw, tomlTable);
          else if (pointer?.startsWith(MARKDOWN_POINTER_PREFIX)) {
            const body = sectionContent(raw, pointer.slice(MARKDOWN_POINTER_PREFIX.length));
            current = body === undefined ? undefined : normalizeSectionBody(body);
          } else if (pointer) current = getJsonAtPointer(raw, pointer);
        } catch {
          skipped.push({ path: op.path, reason: "native config is not parseable" });
          continue;
        }
        if (current === undefined) continue;
        if (sha256(stableStringify(current)) !== owned.checksum) {
          skipped.push({
            path: op.path,
            reason: "config key modified externally; refusing to remove",
          });
          continue;
        }
        pending.push({
          kind: op.type === "mergeJson" ? "json" : op.type === "mergeToml" ? "toml" : "markdown",
          path: op.path,
          pointer: op.type === "mergeJson" ? op.pointer : undefined,
          tomlTable,
          sectionId: op.type === "managedMarkdownSection" ? op.sectionId : undefined,
          target,
        });
      }
    }
  }

  if (opts.dryRun) {
    for (const p of pending) removed.push(p.kind === "path" ? p.path : `${p.path} (config key)`);
    return { removed, skipped, diagnostics, dryRun: true };
  }

  // Backup first, then remove.
  let backupId: string | undefined;
  const backupPaths = [...new Set(pending.map((p) => p.path))];
  const existingBackupPaths: string[] = [];
  for (const p of backupPaths) if (await pathExists(p)) existingBackupPaths.push(p);
  if (existingBackupPaths.length > 0) {
    const backup = await createBackup(
      `${workspace.rootDir}/.agentpack/backups`,
      existingBackupPaths,
      "remove",
    );
    backupId = backup.id;
  }

  for (const p of pending) {
    if (p.kind === "path") {
      await deletePath(p.path);
      removed.push(p.path);
      continue;
    }
    const raw = await readFileIfExists(p.path);
    if (raw === undefined) continue;
    let next: string;
    if (p.kind === "json") next = removeJsonAtPointer(raw, p.pointer!);
    else if (p.kind === "toml") next = removeTomlAtTable(raw, p.tomlTable!);
    else next = removeManagedSection(raw, p.sectionId!);
    await writeFileAtomic(p.path, next);
    removed.push(`${p.path} (config key)`);
  }

  // Prune removed entries from state.
  for (const target of targets) {
    const targetState = state.targets[target];
    if (!targetState) continue;
    const removedPaths = new Set(
      pending.filter((p) => p.kind === "path" && p.target === target).map((p) => p.path),
    );
    targetState.ownedFiles = targetState.ownedFiles.filter((f) => !removedPaths.has(f.path));
    const removedKeys = pending.filter((p) => p.kind !== "path" && p.target === target);
    targetState.ownedConfigKeys = targetState.ownedConfigKeys.filter(
      (k) =>
        !removedKeys.some(
          (r) =>
            r.path === k.path &&
            (r.kind === "json"
              ? k.jsonPointer === r.pointer
              : r.kind === "toml"
                ? JSON.stringify(k.tomlTable) === JSON.stringify(r.tomlTable)
                : k.jsonPointer === MARKDOWN_POINTER_PREFIX + (r.sectionId ?? "")),
        ),
    );
  }
  delete state.trust?.[packName];
  await saveState(workspace.rootDir, state);

  return { removed, skipped, diagnostics, backupId, dryRun: false };
}
