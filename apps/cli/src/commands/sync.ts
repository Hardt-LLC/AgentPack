import type { Command } from "commander";

import { syncWorkspace } from "@agentpack/core";
import type { InstallMode, Scope, Strictness, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { CliError, ExitSignal } from "../errors.js";
import {
  adapterOptionsOf,
  kimiPathStrategyOption,
  modeOption,
  parseTargetList,
  scopeOption,
  strictnessOption,
  targetOption,
} from "../options.js";
import {
  err,
  formatInstallStrategy,
  out,
  printCapabilityTable,
  printDiagnostics,
  printTargetPlans,
} from "../output.js";
import { defaultRegistry } from "../registry.js";

interface SyncOptions extends GlobalOptions {
  profile?: string;
  target?: TargetId;
  targets?: TargetId[];
  scope?: Scope;
  mode?: InstallMode;
  strictness?: Strictness;
  dryRun?: boolean;
  force?: boolean;
  adopt?: boolean;
  trust?: string[];
  kimiPathStrategy?: string;
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("synchronize packs into native target config (locked, backed-up)")
    .option("--profile <name>", "profile to sync")
    .addOption(targetOption())
    .option("--targets <list>", "comma-separated targets (codex,claude,kimi)", parseTargetList)
    .addOption(scopeOption())
    .addOption(modeOption())
    .addOption(strictnessOption())
    .option("--dry-run", "print the plan without modifying any file")
    .option("--force", "overwrite externally modified managed files")
    .option(
      "--adopt",
      "adopt unmanaged paths standing in the way (moved to backup, restored by uninstall)",
    )
    .option(
      "--trust <pack>",
      "trust a pack with executable components for this run (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .addOption(kimiPathStrategyOption())
    .action(async (options: SyncOptions) => {
      if (options.target && options.targets && options.targets.length > 0) {
        throw new CliError("use either --target or --targets, not both", 2);
      }
      const targets = options.target ? [options.target] : options.targets;

      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await syncWorkspace(workspace, defaultRegistry(), {
        profile: options.profile,
        targets,
        scope: options.scope,
        installMode: options.mode,
        strictness: options.strictness,
        dryRun: options.dryRun,
        force: options.force,
        adopt: options.adopt,
        trust: options.trust,
        adapterOptions: adapterOptionsOf(options),
      });

      out(formatInstallStrategy(result.plan));
      out("");
      printCapabilityTable(result.plan.capabilityReports);

      // Trust gate — exit 4.
      if (result.trustRefusals.length > 0) {
        for (const refusal of result.trustRefusals) {
          err(`Trust refusal [${refusal.requirement.pack}]: ${refusal.reason}`);
        }
        printDiagnostics(result.diagnostics);
        throw new ExitSignal(4);
      }

      // Conflicts without --force — exit 3.
      if (result.conflicts.length > 0 && !options.force) {
        err(`Conflicts (${result.conflicts.length}):`);
        for (const conflict of result.conflicts) {
          err(`  - [${conflict.target}] ${conflict.path}: ${conflict.reason}`);
        }
        err("re-run with --force to overwrite");
        throw new ExitSignal(3);
      }

      // Validation-level errors — exit 1.
      if (result.diagnostics.some((d) => d.severity === "error")) {
        printDiagnostics(result.diagnostics);
        throw new ExitSignal(1);
      }
      printDiagnostics(result.diagnostics);

      if (result.dryRun) {
        printTargetPlans(result.plan);
        out("Dry run — no files were modified.");
        throw new ExitSignal(0);
      }

      printTargetPlans(result.plan);
      for (const adoption of result.adoptions ?? []) {
        out(`  adopted [${adoption.target}] ${adoption.path} (backup: ${adoption.backupId})`);
      }
      if (result.backupId) out(`Backup: ${result.backupId}`);
      out("Sync complete.");
      throw new ExitSignal(0);
    });
}
