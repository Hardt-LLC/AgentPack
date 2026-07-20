import type { Command } from "commander";

import { buildPlugins } from "@agentpack/core";
import type { Strictness, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import {
  adapterOptionsOf,
  kimiPathStrategyOption,
  parseCommaList,
  parseTargetList,
  strictnessOption,
} from "../options.js";
import { err, out, printCapabilityTable, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface BuildOptions extends GlobalOptions {
  targets?: TargetId[];
  packs?: string[];
  output?: string;
  strictness?: Strictness;
  dryRun?: boolean;
  kimiPathStrategy?: string;
}

export function registerBuild(program: Command): void {
  program
    .command("build")
    .description("build native plugin bundles into <output>/<target>/<pack>/")
    .option("--targets <list>", "comma-separated targets (codex,claude,kimi)", parseTargetList)
    .option("--packs <list>", "comma-separated pack names", parseCommaList)
    .option("--output <dir>", "output directory (default: dist)")
    .addOption(strictnessOption())
    .option("--dry-run", "plan the bundles without writing them")
    .addOption(kimiPathStrategyOption())
    .action(async (options: BuildOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await buildPlugins(workspace, defaultRegistry(), {
        targets: options.targets,
        packs: options.packs,
        outputDir: options.output,
        strictness: options.strictness,
        dryRun: options.dryRun,
        adapterOptions: adapterOptionsOf(options),
      });

      printCapabilityTable(result.capabilityReports);
      if (result.bundles.length > 0) {
        out(`Bundles (${result.outputDir}):`);
        for (const bundle of result.bundles) {
          out(`  - ${bundle.target}/${bundle.pack}: ${bundle.path}`);
        }
      } else {
        out("No bundles (nothing selected).");
      }
      printDiagnostics(result.diagnostics);
      if (result.dryRun) out("Dry run — no files were modified.");

      if (result.diagnostics.some((d) => d.severity === "error")) {
        err("Build failed.");
        throw new ExitSignal(1);
      }
      throw new ExitSignal(0);
    });
}
