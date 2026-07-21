import path from "node:path";
import type { Command } from "commander";

import { installService, serviceStatus, uninstallService } from "@agentpack/core";

import { resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { err, out } from "../output.js";

/** Absolute path of the running CLI bundle, used in the service definition. */
function cliPath(): string {
  const argv1 = process.argv[1];
  if (argv1 && argv1.endsWith(".mjs")) return path.resolve(argv1);
  // Compiled single-file binary: the executable itself is the CLI.
  return process.execPath;
}

export function registerService(program: Command): void {
  const service = program
    .command("service")
    .description("background operation: run `agentpack watch --collect` at login (no sudo)");

  service
    .command("install")
    .description("install and load the per-user watch service (launchd / systemd --user)")
    .action(async () => {
      const workspaceRoot = await resolveWorkspaceRoot(program.opts<GlobalOptions>());
      const info = await installService({ workspaceRoot, cliPath: cliPath() });
      out(`Service file: ${info.filePath}`);
      out(`Log file: ${info.logPath}`);
      if (info.warning) {
        err(`warning: ${info.warning}`);
        out("Service file written; load it manually using the command(s) above.");
      } else {
        out(
          `Service ${info.label} installed and loaded — runs at login, no further action needed.`,
        );
      }
      throw new ExitSignal(0);
    });

  service
    .command("uninstall")
    .description("unload and remove the per-user watch service")
    .action(async () => {
      const workspaceRoot = await resolveWorkspaceRoot(program.opts<GlobalOptions>());
      await uninstallService({ workspaceRoot });
      out("Service uninstalled.");
      throw new ExitSignal(0);
    });

  service
    .command("status")
    .description("show whether the watch service is installed and running")
    .action(async () => {
      const workspaceRoot = await resolveWorkspaceRoot(program.opts<GlobalOptions>());
      const info = await serviceStatus({ workspaceRoot });
      out(`Platform: ${info.platform}`);
      out(`Service file: ${info.filePath}`);
      out(`Installed: ${info.installed ? "yes" : "no"}`);
      if (info.installed) out(`Running: ${info.running ? "yes" : "no"}`);
      out(`Log file: ${info.logPath}`);
      throw new ExitSignal(0);
    });
}
