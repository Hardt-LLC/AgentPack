import os from "node:os";
import {
  TARGET_IDS,
  type CapabilityReport,
  type Diagnostic,
  type GeneratedArtifact,
  type InstallMode,
  type Scope,
  type Strictness,
  type TargetDetection,
  type TargetId,
} from "@agentpack/schema";
import {
  planOperations,
  type InstallOperation,
  type PlannedOperation,
  type SyncState,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { resolveSelection, type ResolvedSelection, type SelectionOverrides } from "./profiles.js";
import { strictnessDiagnostics } from "./capability.js";
import { buildAdapterContext, type DetectedTargets } from "./detect.js";
import { readGatewayLauncher, syntheticGatewayPack } from "./gateway.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

/** Identify artifacts that install individual MCP server entries. */
function isMcpArtifact(artifact: GeneratedArtifact): boolean {
  if (artifact.kind === "json-merge") return artifact.pointer.startsWith("/mcpServers/");
  if (artifact.kind === "toml-merge") return artifact.table[0] === "mcp_servers";
  return false;
}

export interface TargetPlan {
  target: TargetId;
  detection: TargetDetection | undefined;
  operations: PlannedOperation[];
  /** Stale AgentPack-owned paths no longer desired (will be removed). */
  removals: PlannedOperation[];
  warnings: string[];
}

export interface SyncPlan {
  selection: ResolvedSelection;
  targets: TargetPlan[];
  capabilityReports: CapabilityReport[];
  diagnostics: Diagnostic[];
  installStrategy: "symlink" | "copy";
  scope: Scope;
}

export interface PlanOptions extends SelectionOverrides {
  strictness?: Strictness;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Adapter-specific options (e.g. kimi pathStrategy). */
  adapterOptions?: Record<string, unknown>;
  /** Existing sync state, used to compute stale removals. */
  state?: SyncState;
}

/** Decide the effective install strategy (auto → symlink when reliable). */
export function resolveInstallStrategy(
  installMode: InstallMode,
  platform: NodeJS.Platform,
): "symlink" | "copy" {
  if (installMode === "symlink") return "symlink";
  if (installMode === "copy") return "copy";
  return platform === "win32" ? "copy" : "symlink";
}

/**
 * Build a complete, side-effect-free execution plan. This function never
 * writes to the filesystem.
 */
export async function buildPlan(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  detected: DetectedTargets,
  opts: PlanOptions = {},
): Promise<SyncPlan> {
  const diagnostics: Diagnostic[] = [];
  const capabilityReports: CapabilityReport[] = [];
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  const selection = resolveSelection(workspace, opts, registry.ids());
  diagnostics.push(...selection.diagnostics);

  const strategy = resolveInstallStrategy(selection.installMode, platform);
  const targetPlans: TargetPlan[] = [];

  for (const target of selection.targets) {
    if (!registry.has(target)) {
      diagnostics.push({
        severity: "error",
        message: `no adapter registered for target "${target}"`,
      });
      continue;
    }
    const adapter = registry.get(target);
    const detection = detected[target];
    const warnings: string[] = [...(detection?.warnings ?? [])];
    const context = buildAdapterContext(
      adapter,
      detection,
      selection.scope,
      workspace.rootDir,
      env,
      {
        homeDir: opts.homeDir ?? os.homedir(),
        ...(opts.adapterOptions ?? {}),
      },
    );

    const artifacts: GeneratedArtifact[] = [];
    const gatewayEnabled = workspace.manifest?.gateway?.enabled === true;
    for (const pack of selection.packs) {
      if (pack.targetEnabled[target] === false) continue;
      const report = await adapter.analyze(pack, context);
      capabilityReports.push(report);
      let packArtifacts = await adapter.generate(pack, context);
      if (gatewayEnabled) {
        // In gateway mode individual MCP servers are served by the gateway;
        // targets only get the single gateway entry (injected below).
        packArtifacts = packArtifacts.filter((a) => !isMcpArtifact(a));
      }
      artifacts.push(...packArtifacts);
    }
    if (gatewayEnabled) {
      const launcher = await readGatewayLauncher(workspace.rootDir);
      if (launcher) {
        const gatewayPack = syntheticGatewayPack(
          workspace.manifest?.gateway?.name ?? "agentpack",
          launcher,
        );
        artifacts.push(...(await adapter.generate(gatewayPack, context)));
      } else {
        warnings.push(
          "gateway mode is enabled but gateway.json is missing — run `agentpack gateway setup`",
        );
      }
    }

    const operations = await adapter.planInstall(artifacts, {
      ...context,
      installMode: selection.installMode,
      symlinksReliable: strategy === "symlink",
    });

    const planned = await planOperations(operations as InstallOperation[]);

    // Stale owned paths from a previous sync of this workspace.
    const desiredPaths = new Set(
      (operations as InstallOperation[]).map((op) =>
        op.type === "copyDirectory" ? op.dest : op.type === "removeOwnedPath" ? "" : op.path,
      ),
    );
    const targetState = opts.state?.targets?.[target];
    const removals: PlannedOperation[] = [];
    for (const owned of targetState?.ownedFiles ?? []) {
      if (!desiredPaths.has(owned.path)) {
        removals.push(...(await planOperations([{ type: "removeOwnedPath", path: owned.path }])));
      }
    }

    targetPlans.push({ target, detection, operations: planned, removals, warnings });
  }

  diagnostics.push(...strictnessDiagnostics(capabilityReports, opts.strictness ?? "permissive"));

  return {
    selection,
    targets: targetPlans,
    capabilityReports,
    diagnostics,
    installStrategy: strategy,
    scope: selection.scope,
  };
}
