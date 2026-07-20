import type { Command } from "commander";
import { Option } from "commander";

import { importFromTarget } from "@agentpack/core";
import { TARGET_IDS, type Scope, type TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { scopeOption } from "../options.js";
import { err, out, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface ImportOptions extends GlobalOptions {
  from: TargetId;
  scope?: Scope;
  packName?: string;
  dryRun?: boolean;
}

export function registerImport(program: Command): void {
  program
    .command("import")
    .description("import native config from a target into a new canonical pack")
    .addOption(
      new Option("--from <target>", "target to import from")
        .choices([...TARGET_IDS])
        .makeOptionMandatory(),
    )
    .addOption(scopeOption())
    .option("--pack-name <name>", "name for the imported pack")
    .option("--dry-run", "show what would be imported without writing anything")
    .action(async (options: ImportOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await importFromTarget(workspace, defaultRegistry(), options.from, {
        scope: options.scope,
        packName: options.packName,
        dryRun: options.dryRun,
      });

      out(`Pack: ${result.packName || "(none)"}`);
      out(`Directory: ${result.packDir || "(none)"}`);
      out(`Skills written: ${result.skillsWritten.length}`);
      for (const skill of result.skillsWritten) out(`  - ${skill}`);
      if (result.skillsSkippedDuplicates.length > 0) {
        out(`Duplicates skipped: ${result.skillsSkippedDuplicates.join(", ")}`);
      }
      out(`MCP servers: ${result.mcpServerCount}`);
      out(`Instructions: ${result.instructionCount}`);
      for (const warning of result.warnings) err(`warning: ${warning}`);
      printDiagnostics(result.diagnostics);

      if (result.diagnostics.some((d) => d.severity === "error")) {
        throw new ExitSignal(1);
      }
      if (result.dryRun) {
        out("Dry run — no files were modified.");
      } else {
        out("");
        out(`Add the pack to agentpack.yaml:`);
        out(`  packs:`);
        out(`    - path: ./packs/${result.packName}`);
        out(`and reference "${result.packName}" in a profile.`);
      }
      throw new ExitSignal(0);
    });
}
