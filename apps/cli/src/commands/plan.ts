import type { Command } from "commander";

import { buildPlan, detectTargets } from "@agentpack/core";
import { loadState } from "@agentpack/filesystem";
import type { Scope, Strictness, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import {
  adapterOptionsOf,
  parseTargetList,
  scopeOption,
  strictnessOption,
  kimiPathStrategyOption,
} from "../options.js";
import {
  formatInstallStrategy,
  out,
  printCapabilityTable,
  printDetection,
  printDiagnostics,
  printEnvelope,
  printTargetPlans,
} from "../output.js";
import { defaultRegistry } from "../registry.js";

interface PlanOptions extends GlobalOptions {
  profile?: string;
  targets?: TargetId[];
  scope?: Scope;
  strictness?: Strictness;
  json?: boolean;
  kimiPathStrategy?: string;
}

export function registerPlan(program: Command): void {
  program
    .command("plan")
    .description("preview what a sync would change — never modifies any file")
    .option("--profile <name>", "profile to plan")
    .option("--targets <list>", "comma-separated targets (codex,claude,kimi)", parseTargetList)
    .addOption(scopeOption())
    .addOption(strictnessOption())
    .option("--json", "print a machine-readable JSON envelope")
    .addOption(kimiPathStrategyOption())
    .action(async (options: PlanOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const registry = defaultRegistry();
      const detected = await detectTargets(registry, workspace.rootDir);
      const state = await loadState(workspace.rootDir);
      const plan = await buildPlan(workspace, registry, detected, {
        profile: options.profile,
        targets: options.targets,
        scope: options.scope,
        strictness: options.strictness,
        adapterOptions: adapterOptionsOf(options),
        state,
      });

      const hasErrors = plan.diagnostics.some((d) => d.severity === "error");

      if (options.json) {
        printEnvelope("plan", !hasErrors, {
          profile: plan.selection.profileName,
          scope: plan.scope,
          installMode: plan.selection.installMode,
          installStrategy: plan.installStrategy,
          packs: plan.selection.packs.map((p) => p.metadata.name),
          targets: plan.targets.map((t) => ({
            target: t.target,
            detection: t.detection,
            warnings: t.warnings,
            operations: t.operations.map((p) => ({ action: p.action, detail: p.detail })),
            removals: t.removals.map((p) => ({ action: p.action, detail: p.detail })),
          })),
          capabilities: plan.capabilityReports,
          diagnostics: plan.diagnostics,
        });
      } else {
        out(`Workspace: ${workspace.rootDir}`);
        out(`Profile: ${plan.selection.profileName ?? "(none — all packs)"}`);
        out(`Packs: ${plan.selection.packs.map((p) => p.metadata.name).join(", ") || "(none)"}`);
        out(`Scope: ${plan.scope}`);
        out("");
        printDetection(detected);
        out("");
        out(formatInstallStrategy(plan));
        out("");
        printCapabilityTable(plan.capabilityReports);
        printTargetPlans(plan);
        printDiagnostics(plan.diagnostics);
        out("No files were modified.");
      }
      throw new ExitSignal(hasErrors ? 1 : 0);
    });
}
