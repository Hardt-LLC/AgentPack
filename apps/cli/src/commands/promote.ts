import type { Command } from "commander";

import { promotePack } from "@agentpack/core";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { out, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface PromoteCommandOptions extends GlobalOptions {
  dryRun?: boolean;
}

export function registerPromote(program: Command): void {
  program
    .command("promote")
    .description("promote a pack (e.g. packs/inbox-<target>) into the default profile and sync")
    .argument("<pack>", "pack name to promote")
    .option("--dry-run", "show what would happen without modifying anything")
    .action(async (packName: string, options: PromoteCommandOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await promotePack(workspace, defaultRegistry(), packName, {
        dryRun: options.dryRun,
      });

      printDiagnostics(result.diagnostics);
      if (result.diagnostics.some((d) => d.severity === "error")) throw new ExitSignal(1);

      if (options.dryRun) {
        out(`Dry run — pack "${result.promoted}" would be promoted.`);
        throw new ExitSignal(0);
      }
      out(`Promoted: ${result.promoted}`);
      out(`Profile updated: ${result.profileUpdated ? "yes" : "already in default profile"}`);
      out(`Trust granted: ${result.trustGranted ? "yes" : "no"}`);
      out(`Sync: ${result.synced ? "applied" : "no changes applied"}`);
      throw new ExitSignal(result.synced ? 0 : 1);
    });
}
