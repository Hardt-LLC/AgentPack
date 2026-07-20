import path from "node:path";
import type { Command } from "commander";
import { Option } from "commander";

import { installCollectHook, uninstallCollectHook } from "@agentpack/core";
import { TARGET_IDS, type TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { CliError, ExitSignal } from "../errors.js";
import { out, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

/** Absolute path of the running CLI bundle, used in the hook command. */
function cliPath(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new CliError("cannot determine CLI path for the hook command", 2);
  return path.resolve(argv1);
}

function hookTargetOption(): Option {
  return new Option("--target <target>", "agent to hook")
    .choices([...TARGET_IDS])
    .default("claude");
}

export function registerHooks(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("install agent session hooks (e.g. claude SessionStart collect)");

  hooks
    .command("install")
    .description("run `agentpack collect --quiet` at every agent session start")
    .addOption(hookTargetOption())
    .action(async (options: GlobalOptions & { target: TargetId }) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await installCollectHook(workspace, defaultRegistry(), {
        target: options.target,
        cliPath: cliPath(),
      });
      printDiagnostics(result.diagnostics);
      out(result.message);
      throw new ExitSignal(0);
    });

  hooks
    .command("uninstall")
    .description("remove the AgentPack session-start collect hook")
    .addOption(hookTargetOption())
    .action(async (options: GlobalOptions & { target: TargetId }) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await uninstallCollectHook(workspace, defaultRegistry(), {
        target: options.target,
      });
      printDiagnostics(result.diagnostics);
      out(result.removed ? "Collect hook removed." : "No collect hook installed.");
      throw new ExitSignal(0);
    });
}
