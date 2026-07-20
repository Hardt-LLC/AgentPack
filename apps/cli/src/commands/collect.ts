import type { Command } from "commander";
import { Option } from "commander";

import { collectFromTarget } from "@agentpack/core";
import { TARGET_IDS, type TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { out, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface CollectCommandOptions extends GlobalOptions {
  from?: TargetId;
  dryRun?: boolean;
}

export function registerCollect(program: Command): void {
  program
    .command("collect")
    .description("collect natively installed MCP servers and skills into reviewable inbox packs")
    .addOption(
      new Option("--from <target>", "collect only from this target").choices([...TARGET_IDS]),
    )
    .option("--dry-run", "show what would be collected without writing anything")
    .action(async (options: CollectCommandOptions) => {
      const registry = defaultRegistry();
      const targets = options.from
        ? [options.from]
        : TARGET_IDS.filter((id) => registry.has(id) && registry.get(id).import !== undefined);

      let hadError = false;
      for (const target of targets) {
        // Reload per target so earlier inbox packs join the known set.
        const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
        const result = await collectFromTarget(workspace, registry, target, {
          dryRun: options.dryRun,
        });

        out(`Target ${target}:`);
        for (const name of result.newServers) out(`  + server ${name}`);
        for (const name of result.newSkills) out(`  + skill ${name}`);
        for (const skipped of result.skippedServers) {
          out(`  ~ server ${skipped.name} skipped (${skipped.reason})`);
        }
        if (result.duplicateSkills.length > 0) {
          out(`  ~ duplicate skills skipped: ${result.duplicateSkills.join(", ")}`);
        }
        if (!result.changed) out("  no new items");
        out(`  inbox: ${result.packDir}`);
        printDiagnostics(result.diagnostics);

        if (result.diagnostics.some((d) => d.severity === "error")) {
          hadError = true;
          continue;
        }
        if (result.changed && !options.dryRun) {
          out(
            `  Review packs/inbox-${target}; promote entries into a profiled pack to share them ` +
              `(sync requires --trust for executable components).`,
          );
        }
      }
      if (options.dryRun) out("Dry run — no files were modified.");
      throw new ExitSignal(hadError ? 2 : 0);
    });
}
