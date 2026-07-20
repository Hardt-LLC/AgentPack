import type { Command } from "commander";

import { removePack } from "@agentpack/core";
import type { Scope, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { scopeOption, targetOption } from "../options.js";
import { out, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface RemoveOptions extends GlobalOptions {
  target?: TargetId;
  scope?: Scope;
  dryRun?: boolean;
}

export function registerRemove(program: Command): void {
  program
    .command("remove <pack>")
    .description("remove everything a pack owns on the selected targets")
    .addOption(targetOption())
    .addOption(scopeOption())
    .option("--dry-run", "show what would be removed without deleting anything")
    .action(async (packName: string, options: RemoveOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await removePack(workspace, defaultRegistry(), packName, {
        target: options.target,
        scope: options.scope,
        dryRun: options.dryRun,
      });

      // Targets can share paths (e.g. codex and kimi both use .agents/),
      // which makes the core report them once per target — print each once.
      const removed = [...new Set(result.removed)];
      if (removed.length > 0) {
        out(result.dryRun ? "Would remove:" : "Removed:");
        for (const p of removed) out(`  - ${p}`);
      } else {
        out("Nothing to remove.");
      }
      if (result.skipped.length > 0) {
        out("Skipped:");
        for (const skip of result.skipped) out(`  - ${skip.path} (${skip.reason})`);
      }
      if (result.backupId) out(`Backup: ${result.backupId}`);
      printDiagnostics(result.diagnostics);

      if (result.diagnostics.some((d) => d.severity === "error")) {
        throw new ExitSignal(1);
      }
      throw new ExitSignal(0);
    });
}
