import path from "node:path";
import {
  renderEnvRecord,
  type CanonicalMcpServer,
  type CanonicalPack,
  type Diagnostic,
  type GeneratedArtifact,
  type Scope,
  type TargetId,
} from "@agentpack/schema";
import {
  createBackup,
  getJsonAtPointer,
  getTomlAtTable,
  loadState,
  readFileIfExists,
  removeJsonAtPointer,
  removeTomlAtTable,
  saveState,
  writeFileAtomic,
  type InstallOperation,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { buildAdapterContext, detectTargets } from "./detect.js";
import { resolveSelection, type SelectionOverrides } from "./profiles.js";
import { stableStringify } from "./sync.js";
import { sha256 } from "@agentpack/filesystem";
import type { LoadWorkspaceResult } from "./load-workspace.js";

/* ------------------------- gateway config model ------------------------ */

export interface GatewayServerConfig {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  passEnv?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  allowTools?: string[];
  denyTools?: string[];
}

export interface GatewayFileConfig {
  version: 1;
  /** How agents should launch the gateway process. */
  launcher: { command: string; args: string[] };
  servers: Record<string, GatewayServerConfig>;
}

export function gatewayConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "gateway.json");
}

function toGatewayServer(server: CanonicalMcpServer): GatewayServerConfig {
  const out: GatewayServerConfig = { transport: server.transport };
  if (server.command) out.command = server.command;
  if (server.args) out.args = server.args;
  if (server.cwd) out.cwd = server.cwd;
  if (server.url) out.url = server.url;
  const headers = renderEnvRecord(server.headers);
  if (headers) out.headers = headers;
  const env = renderEnvRecord(server.env);
  if (env) out.env = env;
  if (server.passEnv) out.passEnv = server.passEnv;
  if (server.startupTimeoutMs) out.startupTimeoutMs = server.startupTimeoutMs;
  if (server.toolTimeoutMs) out.toolTimeoutMs = server.toolTimeoutMs;
  if (server.allowTools) out.allowTools = server.allowTools;
  if (server.denyTools) out.denyTools = server.denyTools;
  return out;
}

/**
 * Build the gateway.json content from the selected packs' MCP servers.
 * Identical server definitions across packs are deduplicated; conflicting
 * ones are reported by validateWorkspace before this is called.
 */
export function generateGatewayConfig(
  packs: CanonicalPack[],
  launcher: { command: string; args: string[] },
): GatewayFileConfig {
  const servers: Record<string, GatewayServerConfig> = {};
  for (const pack of packs) {
    for (const [name, server] of Object.entries(pack.mcpServers)) {
      if (server.enabled === false) continue;
      if (servers[name]) continue; // identical duplicate already validated
      servers[name] = toGatewayServer(server);
    }
  }
  return { version: 1, launcher, servers };
}

/** A synthetic single-server pack used to render the gateway entry per target. */
export function syntheticGatewayPack(
  name: string,
  launcher: { command: string; args: string[] },
): CanonicalPack {
  const server: CanonicalMcpServer = {
    name,
    transport: "stdio",
    command: launcher.command,
    args: launcher.args,
    enabled: true,
  };
  return {
    metadata: { name: "agentpack-gateway", version: "0.1.0" },
    rootDir: "",
    skills: [],
    instructions: [],
    mcpServers: { [name]: server },
    hooks: [],
    targetExtensions: {},
    targetEnabled: {},
  };
}

/** Read the launcher recorded in an existing gateway.json. */
export async function readGatewayLauncher(
  workspaceRoot: string,
): Promise<{ command: string; args: string[] } | undefined> {
  const raw = await readFileIfExists(gatewayConfigPath(workspaceRoot));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as GatewayFileConfig;
    return parsed.launcher;
  } catch {
    return undefined;
  }
}

/* --------------------------- install / remove -------------------------- */

export interface GatewaySetupOptions extends SelectionOverrides {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Absolute path of the agentpack CLI bundle used in the launcher. */
  cliPath: string;
  /**
   * Full launcher command prefix (e.g. ["/usr/local/bin/agentpack"] for a
   * compiled binary, or ["node", "/path/cli.mjs"] for a JS bundle).
   * Defaults to ["node", cliPath].
   */
  launcherCommand?: string[];
  /** Force overwrite of externally modified config keys. */
  force?: boolean;
  /**
   * Adopt pre-existing unmanaged MCP entries that duplicate canonical
   * servers (recorded for uninstall restoration). Without this, duplicates
   * are reported as warnings and left in place.
   */
  adopt?: boolean;
}

export interface GatewaySetupResult {
  configPath: string;
  serverCount: number;
  reclaimedKeys: Array<{ target: TargetId; path: string; key: string }>;
  adoptedKeys: Array<{ target: TargetId; path: string; key: string }>;
  installed: Array<{ target: TargetId; detail: string }>;
  backupId?: string;
  diagnostics: Diagnostic[];
}

function keyId(path: string, pointer?: string, tomlTable?: string[]): string {
  return `${path}#${pointer ?? tomlTable?.join("/") ?? ""}`;
}

/**
 * Turn on gateway mode: write gateway.json, install ONE MCP entry per target
 * pointing at the gateway, and reclaim previously-synced individual MCP
 * config keys that AgentPack owns. Skills/instructions are unaffected.
 */
export async function setupGateway(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: GatewaySetupOptions,
): Promise<GatewaySetupResult> {
  const diagnostics: Diagnostic[] = [];
  const selection = resolveSelection(workspace, opts, registry.ids());
  diagnostics.push(...selection.diagnostics);

  const gatewayName = workspace.manifest?.gateway?.name ?? "agentpack";
  const configPath = gatewayConfigPath(workspace.rootDir);
  const launcherPrefix = opts.launcherCommand ?? ["node", opts.cliPath];
  const launcher = {
    command: launcherPrefix[0]!,
    args: [...launcherPrefix.slice(1), "gateway", "run", "--config", configPath],
  };
  const config = generateGatewayConfig(selection.packs, launcher);
  const serverCount = Object.keys(config.servers).length;
  if (config.servers[gatewayName]) {
    diagnostics.push({
      severity: "error",
      message: `an MCP server named "${gatewayName}" collides with the gateway entry name`,
    });
    return {
      configPath,
      serverCount,
      reclaimedKeys: [],
      adoptedKeys: [],
      installed: [],
      diagnostics,
    };
  }

  const env = opts.env ?? process.env;
  let state = await loadState(workspace.rootDir);
  const detected = await detectTargets(registry, workspace.rootDir, {
    env,
    homeDir: opts.homeDir,
  });

  // 1. Write gateway.json (deterministic).
  await writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");

  // 2. Adopt pre-existing duplicate MCP entries (restorably) or warn.
  const adoptedKeys: GatewaySetupResult["adoptedKeys"] = [];
  const { adoptDuplicateMcpServers } = await import("./adopt.js");
  const canonicalNames = Object.keys(config.servers);
  if (opts.adopt) {
    const adoptResult = await adoptDuplicateMcpServers(workspace, registry, canonicalNames, opts);
    adoptedKeys.push(...adoptResult.adopted);
    diagnostics.push(...adoptResult.diagnostics);
    // Adoption saved its own state updates — reload so we don't clobber them.
    state = await loadState(workspace.rootDir);
  } else {
    const probe = await adoptDuplicateMcpServers(workspace, registry, canonicalNames, {
      ...opts,
      dryRun: true,
    });
    for (const dup of probe.adopted) {
      diagnostics.push({
        severity: "warning",
        message: `[${dup.target}] unmanaged MCP entry duplicates a canonical server and stays active alongside the gateway: ${dup.key} (re-run with --adopt to take it over restorably)`,
      });
    }
  }

  // 2. Per target: install gateway entry, reclaim individual MCP keys.
  const scope: Scope = selection.scope;
  const reclaimedKeys: GatewaySetupResult["reclaimedKeys"] = [];
  const installed: GatewaySetupResult["installed"] = [];
  let backupId: string | undefined;

  for (const target of selection.targets) {
    if (!registry.has(target)) continue;
    const adapter = registry.get(target);
    const context = buildAdapterContext(adapter, detected[target], scope, workspace.rootDir, env, {
      homeDir: opts.homeDir,
    });
    const pack = syntheticGatewayPack(gatewayName, launcher);
    const artifacts: GeneratedArtifact[] = await adapter.generate(pack, context);
    const ops = (await adapter.planInstall(artifacts, {
      ...context,
      installMode: "copy",
      symlinksReliable: false,
    })) as InstallOperation[];

    const targetState = state.targets[target];
    const newKeys: Array<{ path: string; pointer?: string; tomlTable?: string[]; value: unknown }> =
      [];
    for (const op of ops) {
      if (op.type === "mergeJson")
        newKeys.push({ path: op.path, pointer: op.pointer, value: op.value });
      if (op.type === "mergeToml")
        newKeys.push({ path: op.path, tomlTable: op.table, value: op.value });
    }

    // Reclaim owned individual MCP keys (json /mcpServers/*, toml mcp_servers/*).
    const reclaimFiles = new Set<string>();
    if (targetState) {
      const keep: typeof targetState.ownedConfigKeys = [];
      for (const key of targetState.ownedConfigKeys) {
        const isMcpKey =
          (key.jsonPointer?.startsWith("/mcpServers/") ?? false) ||
          (key.tomlTable?.[0] === "mcp_servers" && key.tomlTable.length === 2);
        const isGatewayKey = newKeys.some(
          (n) =>
            n.path === key.path &&
            ((n.pointer !== undefined && n.pointer === key.jsonPointer) ||
              (n.tomlTable !== undefined &&
                JSON.stringify(n.tomlTable) === JSON.stringify(key.tomlTable))),
        );
        if (!isMcpKey || isGatewayKey) {
          keep.push(key);
          continue;
        }
        // Verify the on-disk value is still ours before removing.
        const raw = await readFileIfExists(key.path);
        if (raw === undefined) continue;
        let current: unknown;
        try {
          current = key.tomlTable
            ? getTomlAtTable(raw, key.tomlTable)
            : getJsonAtPointer(raw, key.jsonPointer!);
        } catch {
          keep.push(key);
          diagnostics.push({
            severity: "warning",
            message: `cannot parse ${key.path}; key left in place`,
          });
          continue;
        }
        if (current === undefined) continue;
        if (sha256(stableStringify(current)) !== key.checksum && !opts.force) {
          keep.push(key);
          diagnostics.push({
            severity: "error",
            message: `${keyId(key.path, key.jsonPointer, key.tomlTable)} was modified externally; re-run with --force`,
          });
          continue;
        }
        reclaimFiles.add(key.path);
        reclaimedKeys.push({
          target,
          path: key.path,
          key: key.jsonPointer ?? key.tomlTable!.join("."),
        });
      }
      targetState.ownedConfigKeys = keep;
    }
    if (diagnostics.some((d) => d.severity === "error")) {
      return { configPath, serverCount, reclaimedKeys, adoptedKeys, installed, diagnostics };
    }

    // Apply removals + gateway entry. Back up BEFORE modifying, never after.
    const { applyOperations } = await import("@agentpack/filesystem");
    const filesToTouch = new Set<string>(reclaimFiles);
    for (const op of ops) {
      if (op.type === "mergeJson" || op.type === "mergeToml") filesToTouch.add(op.path);
    }
    const existingToBackup: string[] = [];
    for (const file of filesToTouch) {
      if ((await readFileIfExists(file)) !== undefined) existingToBackup.push(file);
    }
    if (existingToBackup.length > 0) {
      const backup = await createBackup(
        path.join(workspace.rootDir, ".agentpack", "backups"),
        existingToBackup,
        "gateway",
      );
      backupId = backup.id;
    }

    for (const file of reclaimFiles) {
      const raw = await readFileIfExists(file);
      if (raw === undefined) continue;
      let next = raw;
      for (const reclaimed of reclaimedKeys.filter((r) => r.path === file)) {
        next = reclaimed.key.startsWith("/")
          ? removeJsonAtPointer(next, reclaimed.key)
          : removeTomlAtTable(next, reclaimed.key.split("."));
      }
      await writeFileAtomic(file, next);
    }
    for (const op of ops) {
      await applyOperations([op]);
    }

    // Record ownership of the gateway key.
    state.targets[target] = targetState ?? { ownedFiles: [], ownedConfigKeys: [] };
    for (const n of newKeys) {
      state.targets[target]!.ownedConfigKeys.push({
        path: n.path,
        jsonPointer: n.pointer,
        tomlTable: n.tomlTable,
        checksum: sha256(stableStringify(n.value)),
      });
      installed.push({ target, detail: keyId(n.path, n.pointer, n.tomlTable) });
    }
  }

  await saveState(workspace.rootDir, state);
  return { configPath, serverCount, reclaimedKeys, adoptedKeys, installed, backupId, diagnostics };
}

/** Remove the gateway entry from each target (individual servers can then be restored with a normal sync). */
export async function uninstallGateway(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: SelectionOverrides & { env?: Record<string, string | undefined>; homeDir?: string },
): Promise<{ removed: string[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const removed: string[] = [];
  const state = await loadState(workspace.rootDir);
  const launcher = await readGatewayLauncher(workspace.rootDir);
  const gatewayName = workspace.manifest?.gateway?.name ?? "agentpack";
  const selection = resolveSelection(workspace, opts, registry.ids());

  for (const target of selection.targets) {
    const targetState = state.targets[target];
    if (!targetState) continue;
    for (const key of [...targetState.ownedConfigKeys]) {
      const isGatewayKey =
        key.jsonPointer === `/mcpServers/${gatewayName}` ||
        JSON.stringify(key.tomlTable) === JSON.stringify(["mcp_servers", gatewayName]);
      if (!isGatewayKey) continue;
      const raw = await readFileIfExists(key.path);
      if (raw !== undefined) {
        const next = key.tomlTable
          ? removeTomlAtTable(raw, key.tomlTable)
          : removeJsonAtPointer(raw, key.jsonPointer!);
        await writeFileAtomic(key.path, next);
      }
      targetState.ownedConfigKeys.splice(targetState.ownedConfigKeys.indexOf(key), 1);
      removed.push(keyId(key.path, key.jsonPointer, key.tomlTable));
    }
  }
  if (!launcher) {
    diagnostics.push({
      severity: "warning",
      message: "gateway.json not found; nothing else to clean up",
    });
  }
  await saveState(workspace.rootDir, state);
  return { removed, diagnostics };
}
