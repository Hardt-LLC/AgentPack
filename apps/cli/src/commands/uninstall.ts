import type { Command } from "commander";

import { uninstallWorkspace } from "@agentpack/core";
import type { Scope, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { parseTargetList, scopeOption } from "../options.js";
import { out, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface UninstallCommandOptions extends GlobalOptions {
  targets?: TargetId[];
  scope?: Scope;
  dryRun?: boolean;
}

export function registerUninstall(program: Command): void {
  program
    .command("uninstall")
    .description(
      "remove everything AgentPack owns from targets and restore adopted (pre-AgentPack) config",
    )
    .option("--targets <list>", "comma-separated targets (codex,claude,kimi)", parseTargetList)
    .addOption(scopeOption())
    .option("--dry-run", "show what would be removed and restored")
    .action(async (options: UninstallCommandOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await uninstallWorkspace(workspace, defaultRegistry(), {
        targets: options.targets,
        scope: options.scope,
        dryRun: options.dryRun,
      });
      printDiagnostics(result.diagnostics);
      const verb = result.dryRun ? "would remove" : "removed";
      for (const entry of result.removedOwned) out(`  ${verb}: ${entry}`);
      for (const key of result.restoredKeys) {
        out(`  ${result.dryRun ? "would restore" : "restored"} key: ${key}`);
      }
      for (const p of result.restoredPaths) {
        out(`  ${result.dryRun ? "would restore" : "restored"} path: ${p}`);
      }
      for (const skip of result.skipped) out(`  skipped: ${skip.path} (${skip.reason})`);
      out(
        result.dryRun
          ? "Dry run — nothing was changed."
          : "Uninstall complete. Original configuration restored.",
      );
      throw new ExitSignal(0);
    });
}
