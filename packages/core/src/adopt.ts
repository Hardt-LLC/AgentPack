import path from "node:path";
import { promises as fs } from "node:fs";
import {
  type Diagnostic,
  type GeneratedArtifact,
  type Scope,
  type TargetId,
} from "@agentpack/schema";
import {
  createBackup,
  getTomlAtTable,
  hashDirectory,
  isSymlink,
  loadState,
  pathExists,
  readFileIfExists,
  removeJsonAtPointer,
  removeTomlAtTable,
  saveState,
  sha256,
  writeFileAtomic,
  type InstallOperation,
  type SyncState,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { buildAdapterContext, detectTargets } from "./detect.js";
import { resolveSelection, type SelectionOverrides } from "./profiles.js";
import { stableStringify } from "./sync.js";
import { syntheticGatewayPack } from "./gateway.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

/**
 * Adoption: take over pre-existing unmanaged native configuration while
 * remembering the exact original state, so `agentpack uninstall` can put it
 * back byte-for-byte. Nothing adopted is ever lost — values are recorded in
 * state.json and whole paths are moved into backups first.
 */

export interface AdoptKeysResult {
  adopted: Array<{ target: TargetId; path: string; key: string }>;
  skipped: Array<{ target: TargetId; path: string; key: string; reason: string }>;
  backupId?: string;
  diagnostics: Diagnostic[];
}

export interface AdoptOptions extends SelectionOverrides {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  dryRun?: boolean;
}

function stateWithAdopted(state: SyncState, target: TargetId) {
  const targetState = (state.targets[target] ??= { ownedFiles: [], ownedConfigKeys: [] });
  const adopted = (targetState.adopted ??= { configKeys: [], paths: [] });
  return { targetState, adopted };
}

/**
 * Locate each target's native MCP file by rendering the gateway entry and
 * inspecting where the adapter would put it.
 */
async function mcpFileOf(
  adapter: import("@agentpack/schema").TargetAdapter,
  context: import("@agentpack/schema").AdapterContext,
): Promise<{ path: string; format: "json" | "toml" } | undefined> {
  const pack = syntheticGatewayPack("agentpack", { command: "node", args: ["x"] });
  const artifacts: GeneratedArtifact[] = await adapter.generate(pack, context);
  const ops = (await adapter.planInstall(artifacts, {
    ...context,
    installMode: "copy",
    symlinksReliable: false,
  })) as InstallOperation[];
  for (const op of ops) {
    if (op.type === "mergeJson") return { path: op.path, format: "json" };
    if (op.type === "mergeToml") return { path: op.path, format: "toml" };
  }
  return undefined;
}

/**
 * Adopt native MCP server entries whose names match canonical servers
 * (case-insensitive, e.g. claude's `XcodeBuildMCP` ↔ canonical
 * `xcodebuildmcp`). The entries are removed from the native file and their
 * values recorded in state for restoration.
 */
export async function adoptDuplicateMcpServers(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  canonicalServerNames: string[],
  opts: AdoptOptions = {},
): Promise<AdoptKeysResult> {
  const diagnostics: Diagnostic[] = [];
  const adoptedOut: AdoptKeysResult["adopted"] = [];
  const skipped: AdoptKeysResult["skipped"] = [];
  const canonical = new Set(canonicalServerNames.map((n) => n.toLowerCase()));
  const selection = resolveSelection(workspace, opts, registry.ids());
  const env = opts.env ?? process.env;
  const state = await loadState(workspace.rootDir);
  const detected = await detectTargets(registry, workspace.rootDir, {
    env,
    homeDir: opts.homeDir,
  });
  const scope: Scope = selection.scope;
  const backupsDir = path.join(workspace.rootDir, ".agentpack", "backups");
  const backupIds: string[] = [];

  for (const target of selection.targets) {
    if (!registry.has(target)) continue;
    const adapter = registry.get(target);
    const context = buildAdapterContext(adapter, detected[target], scope, workspace.rootDir, env, {
      homeDir: opts.homeDir,
    });
    const located = await mcpFileOf(adapter, context);
    if (!located) continue;
    const raw = await readFileIfExists(located.path);
    if (raw === undefined) continue;

    const { adopted } = stateWithAdopted(state, target);
    if (located.format === "json") {
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        diagnostics.push({ severity: "warning", message: `cannot parse ${located.path}; skipped` });
        continue;
      }
      const servers = (doc["mcpServers"] ?? {}) as Record<string, unknown>;
      let next = raw;
      for (const [name, value] of Object.entries(servers)) {
        if (!canonical.has(name.toLowerCase())) continue;
        if (
          adopted.configKeys.some(
            (k) => k.path === located.path && k.jsonPointer === `/mcpServers/${name}`,
          )
        ) {
          continue; // already adopted earlier
        }
        adoptedOut.push({ target, path: located.path, key: `/mcpServers/${name}` });
        if (!opts.dryRun) {
          adopted.configKeys.push({
            path: located.path,
            jsonPointer: `/mcpServers/${name}`,
            value,
            checksum: sha256(stableStringify(value)),
          });
          next = removeJsonAtPointer(next, `/mcpServers/${name}`);
        }
      }
      if (!opts.dryRun && next !== raw) {
        // Back up BEFORE modifying — never after.
        const backup = await createBackup(backupsDir, [located.path], "adopt");
        backupIds.push(backup.id);
        await writeFileAtomic(located.path, next);
      }
      continue;
    }

    // TOML (codex config.toml)
    let servers: Record<string, unknown> | undefined;
    try {
      servers = getTomlAtTable(raw, ["mcp_servers"]) as Record<string, unknown> | undefined;
    } catch {
      diagnostics.push({ severity: "warning", message: `cannot parse ${located.path}; skipped` });
      continue;
    }
    if (servers === undefined || typeof servers !== "object") continue;
    let next = raw;
    for (const name of Object.keys(servers)) {
      if (!canonical.has(name.toLowerCase())) continue;
      if (
        adopted.configKeys.some(
          (k) =>
            k.path === located.path &&
            JSON.stringify(k.tomlTable) === JSON.stringify(["mcp_servers", name]),
        )
      ) {
        continue;
      }
      const value = getTomlAtTable(next, ["mcp_servers", name]);
      adoptedOut.push({ target, path: located.path, key: `mcp_servers.${name}` });
      if (!opts.dryRun) {
        adopted.configKeys.push({
          path: located.path,
          tomlTable: ["mcp_servers", name],
          value,
          checksum: sha256(stableStringify(value)),
        });
        next = removeTomlAtTable(next, ["mcp_servers", name]);
      }
    }
    if (!opts.dryRun && next !== raw) {
      const backup = await createBackup(backupsDir, [located.path], "adopt");
      backupIds.push(backup.id);
      await writeFileAtomic(located.path, next);
    }
  }

  if (!opts.dryRun) await saveState(workspace.rootDir, state);
  return { adopted: adoptedOut, skipped, backupId: backupIds[0], diagnostics };
}

/* ---------------------- path adoption inside sync ---------------------- */

export interface PathAdoption {
  target: TargetId;
  path: string;
  type: "file" | "directory";
  backupId: string;
}

/**
 * Move an unmanaged path aside (into a backup) so a planned create can take
 * its place. Returns the adoption record, or undefined when no adoption is
 * needed (path absent, or already identical to the desired content).
 */
export async function adoptPathIfNeeded(
  workspaceRoot: string,
  target: TargetId,
  op: InstallOperation,
  desiredChecksum: string | undefined,
  state: SyncState,
): Promise<PathAdoption | undefined> {
  const dest = op.type === "copyDirectory" ? op.dest : op.type === "removeOwnedPath" ? "" : op.path;
  if (!dest || !(await pathExists(dest))) return undefined;
  if (await isSymlink(dest)) return undefined; // symlinks are replaced atomically, nothing to adopt

  // Skip adoption when the existing content already matches the desired one.
  if (desiredChecksum !== undefined) {
    const stat = await fs.stat(dest);
    const current = stat.isDirectory()
      ? await hashDirectory(dest)
      : sha256(await fs.readFile(dest));
    if (current === desiredChecksum) return undefined;
  }

  const stat = await fs.stat(dest);
  const type = stat.isDirectory() ? "directory" : "file";
  const backup = await createBackup(
    path.join(workspaceRoot, ".agentpack", "backups"),
    [dest],
    "adopt",
  );
  await fs.rm(dest, { recursive: type === "directory", force: true });

  const { adopted } = stateWithAdopted(state, target);
  if (!adopted.paths.some((p) => p.path === dest)) {
    adopted.paths.push({ path: dest, type, backupId: backup.id });
  }
  return { target, path: dest, type, backupId: backup.id };
}
