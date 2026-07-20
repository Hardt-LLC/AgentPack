import { TARGET_IDS, type Diagnostic } from "@agentpack/schema";
import type { AdapterRegistry } from "./registry.js";
import { buildPlan, type PlanOptions, type SyncPlan } from "./plan.js";
import { detectTargets } from "./detect.js";
import { loadState } from "@agentpack/filesystem";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface DiffEntry {
  target: string;
  action: "create" | "update" | "remove";
  detail: string;
}

export interface DiffResult {
  plan: SyncPlan;
  entries: DiffEntry[];
  diagnostics: Diagnostic[];
  /** True when desired state matches installed state. */
  clean: boolean;
}

/**
 * Difference between desired canonical state and installed state.
 * Never modifies files. Exit-code mapping happens in the CLI:
 * 0 = clean, 1 = differences, 2 = validation/execution error.
 */
export async function diffWorkspace(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: PlanOptions = {},
): Promise<DiffResult> {
  const detected = await detectTargets(registry, workspace.rootDir, {
    env: opts.env,
    homeDir: opts.homeDir,
  });
  const state = await loadState(workspace.rootDir);
  const plan = await buildPlan(workspace, registry, detected, { ...opts, state });

  const entries: DiffEntry[] = [];
  for (const targetPlan of plan.targets) {
    for (const planned of targetPlan.operations) {
      if (planned.action === "noop") continue;
      entries.push({
        target: targetPlan.target,
        action: planned.action === "remove" ? "remove" : planned.action,
        detail: planned.detail,
      });
    }
    for (const removal of targetPlan.removals) {
      if (removal.action === "noop") continue;
      entries.push({ target: targetPlan.target, action: "remove", detail: removal.detail });
    }
  }

  return {
    plan,
    entries,
    diagnostics: plan.diagnostics,
    clean: entries.length === 0,
  };
}

export { TARGET_IDS };
