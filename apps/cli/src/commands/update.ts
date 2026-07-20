import type { Command } from "commander";

import { loadWorkspace, readLockfile } from "@agentpack/core";

import { resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import { CliError, ExitSignal } from "../errors.js";
import { out, printDiagnostics } from "../output.js";

export function registerUpdate(program: Command): void {
  program
    .command("update [pack]")
    .description("refresh git pack sources to their newest ref and report resolved commits")
    .action(async (packName: string | undefined) => {
      const root = await resolveWorkspaceRoot(program.opts<GlobalOptions>());
      // Refreshes git checkouts and rewrites .agentpack/lock.json when refs move.
      const workspace = await loadWorkspace(root, { updateGitSources: true });

      if (packName && !workspace.packs.some((p) => p.pack?.metadata.name === packName)) {
        throw new CliError(`pack not found: ${packName}`, 2);
      }
      printDiagnostics(workspace.diagnostics);
      if (workspace.diagnostics.some((d) => d.severity === "error")) {
        throw new ExitSignal(1);
      }

      const lockfile = await readLockfile(root);
      const sources = Object.entries(lockfile.sources);
      if (sources.length === 0) {
        out("No git pack sources in this workspace — nothing to update.");
      } else {
        out("Git sources:");
        for (const [key, source] of sources) {
          out(`  - ${key}`);
          out(`    commit: ${source.commit}${source.ref ? ` (ref: ${source.ref})` : ""}`);
        }
      }
      if (packName) {
        out(
          `Note: "${packName}" was verified to exist; git sources above were refreshed (git-source updates apply to all sources).`,
        );
      }
      throw new ExitSignal(0);
    });
}
