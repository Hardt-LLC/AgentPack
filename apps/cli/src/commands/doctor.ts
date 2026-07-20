import path from "node:path";
import type { Command } from "commander";

import {
  findWorkspaceRoot,
  loadWorkspace,
  runDoctor,
  type LoadWorkspaceResult,
} from "@agentpack/core";

import type { GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { out, printEnvelope } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface DoctorOptions extends GlobalOptions {
  json?: boolean;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("run environment and workspace health checks")
    .option("--json", "print a machine-readable JSON envelope")
    .action(async (options: DoctorOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      // Doctor also runs outside a workspace and reports it as a failing check.
      const root = globalOptions.workspace
        ? path.resolve(globalOptions.workspace)
        : await findWorkspaceRoot(process.cwd());
      const workspace: LoadWorkspaceResult | undefined = root
        ? await loadWorkspace(root)
        : undefined;

      const report = await runDoctor(workspace, defaultRegistry());

      if (options.json) {
        printEnvelope("doctor", report.ok, { checks: report.checks });
      } else {
        for (const check of report.checks) {
          out(`${check.status.toUpperCase()} ${check.name} — ${check.message}`);
        }
      }
      throw new ExitSignal(report.ok ? 0 : 1);
    });
}
