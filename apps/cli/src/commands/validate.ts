import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { detectTargets, loadPack, loadWorkspace, validateWorkspace } from "@agentpack/core";
import type { Diagnostic, Strictness } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { strictnessOption } from "../options.js";
import { err, out, printCapabilityTable, printDiagnostics, printEnvelope } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface ValidateOptions extends GlobalOptions {
  profile?: string;
  strictness?: Strictness;
  json?: boolean;
}

export function registerValidate(program: Command): void {
  program
    .command("validate [path]")
    .description("validate the workspace, or a single pack directory containing pack.yaml")
    .option("--profile <name>", "profile to validate")
    .addOption(strictnessOption())
    .option("--json", "print a machine-readable JSON envelope")
    .action(async (targetPath: string | undefined, options: ValidateOptions) => {
      const globalOptions = program.opts<GlobalOptions>();

      // Single-pack mode: the path itself contains a pack.yaml.
      if (targetPath) {
        const packDir = path.resolve(targetPath);
        const isPack = await fs
          .stat(path.join(packDir, "pack.yaml"))
          .then((s) => s.isFile())
          .catch(() => false);
        if (isPack) {
          const result = await loadPack(packDir);
          const diagnostics: Diagnostic[] = result.diagnostics;
          const ok = !diagnostics.some((d) => d.severity === "error");
          if (options.json) {
            printEnvelope("validate", ok, { pack: result.manifest?.metadata.name, diagnostics });
          } else {
            out(`Pack: ${result.manifest?.metadata.name ?? packDir}`);
            printDiagnostics(diagnostics);
            if (diagnostics.length === 0) out("No problems found.");
          }
          throw new ExitSignal(ok ? 0 : 1);
        }
      }

      const workspace = targetPath
        ? await loadWorkspace(path.resolve(targetPath))
        : await loadCliWorkspace(globalOptions);
      const registry = defaultRegistry();
      const detected = await detectTargets(registry, workspace.rootDir);
      const result = await validateWorkspace(workspace, registry, detected, {
        profile: options.profile,
        strictness: options.strictness,
      });

      if (options.json) {
        printEnvelope("validate", result.ok, {
          diagnostics: result.diagnostics,
          capabilities: result.capabilityReports,
        });
      } else {
        printDiagnostics(result.diagnostics);
        printCapabilityTable(result.capabilityReports);
        if (result.ok) {
          out(
            result.diagnostics.length === 0
              ? "Workspace is valid."
              : "Workspace is valid (warnings only).",
          );
        } else {
          err("Workspace validation failed.");
        }
      }
      throw new ExitSignal(result.ok ? 0 : 1);
    });
}
