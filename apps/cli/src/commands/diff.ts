import type { Command } from "commander";

import { diffWorkspace } from "@agentpack/core";
import type { Scope, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { scopeOption, targetOption } from "../options.js";
import { out, printDiagnostics, printEnvelope } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface DiffOptions extends GlobalOptions {
  target?: TargetId;
  profile?: string;
  scope?: Scope;
  json?: boolean;
}

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("show the difference between desired and installed state")
    .addOption(targetOption())
    .option("--profile <name>", "profile to diff")
    .addOption(scopeOption())
    .option("--json", "print a machine-readable JSON envelope")
    .action(async (options: DiffOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await diffWorkspace(workspace, defaultRegistry(), {
        targets: options.target ? [options.target] : undefined,
        profile: options.profile,
        scope: options.scope,
      });

      const hasErrors = result.diagnostics.some((d) => d.severity === "error");

      if (options.json) {
        printEnvelope("diff", !hasErrors && result.clean, {
          clean: result.clean,
          entries: result.entries,
          diagnostics: result.diagnostics,
        });
      } else {
        if (result.clean && !hasErrors) {
          out("No differences.");
        } else {
          for (const entry of result.entries) {
            out(`[${entry.target}] ${entry.action}: ${entry.detail}`);
          }
        }
        printDiagnostics(result.diagnostics);
      }

      if (hasErrors) throw new ExitSignal(2);
      throw new ExitSignal(result.clean ? 0 : 1);
    });
}
