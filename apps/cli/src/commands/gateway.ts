import path from "node:path";
import type { Command } from "commander";

import { setupGateway, uninstallGateway } from "@agentpack/core";
import type { Scope, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { CliError, ExitSignal } from "../errors.js";
import { parseTargetList, scopeOption } from "../options.js";
import { err, out, printDiagnostics } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface GatewaySetupOptions extends GlobalOptions {
  targets?: TargetId[];
  scope?: Scope;
  force?: boolean;
  adopt?: boolean;
}

/** Absolute path of the running CLI bundle, used in the gateway launcher. */
function cliPath(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new CliError("cannot determine CLI path for the gateway launcher", 2);
  return path.resolve(argv1);
}

export function registerGateway(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("MCP aggregation gateway: one entry point for all MCP servers");

  gateway
    .command("run")
    .description("run the gateway proxy on stdio (this is what agents launch)")
    .requiredOption("--config <path>", "path to gateway.json")
    .action(async (options: { config: string }) => {
      // Protocol lives on stdout; everything else must go to stderr.
      const { loadGatewayConfig, Gateway } = await import("@agentpack/gateway");
      const config = await loadGatewayConfig(path.resolve(options.config));
      const gw = new Gateway(config, {
        log: (msg) => process.stderr.write(`[agentpack-gateway] ${msg}\n`),
      });
      await gw.start();
      const degraded = gw.status().filter((s) => s.state === "degraded");
      for (const s of degraded) {
        process.stderr.write(`[agentpack-gateway] degraded: ${s.name} (${s.error ?? "unknown"})\n`);
      }
      const shutdown = () => void gw.stop().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await gw.run();
    });

  gateway
    .command("setup")
    .description("write gateway.json and install ONE gateway MCP entry per target")
    .option("--targets <list>", "comma-separated targets (codex,claude,kimi)", parseTargetList)
    .addOption(scopeOption())
    .option("--force", "reclaim config keys even if modified externally")
    .option(
      "--adopt",
      "adopt unmanaged MCP entries duplicating canonical servers (restored by uninstall)",
    )
    .action(async (options: GatewaySetupOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      if (workspace.manifest?.gateway?.enabled !== true) {
        err(
          "warning: agentpack.yaml does not set gateway.enabled — sync will reinstall individual servers.",
        );
        err("add `gateway: { enabled: true }` to agentpack.yaml to make gateway mode permanent.");
      }
      const result = await setupGateway(workspace, defaultRegistry(), {
        targets: options.targets,
        scope: options.scope,
        force: options.force,
        adopt: options.adopt,
        cliPath: cliPath(),
      });
      printDiagnostics(result.diagnostics);
      if (result.diagnostics.some((d) => d.severity === "error")) throw new ExitSignal(1);
      out(`Gateway config: ${result.configPath} (${result.serverCount} server(s))`);
      for (const adopted of result.adoptedKeys) {
        out(`  adopted [${adopted.target}] ${adopted.path} ${adopted.key}`);
      }
      for (const reclaimed of result.reclaimedKeys) {
        out(`  reclaimed [${reclaimed.target}] ${reclaimed.path} ${reclaimed.key}`);
      }
      for (const entry of result.installed) {
        out(`  installed [${entry.target}] ${entry.detail}`);
      }
      if (result.backupId) out(`Backup: ${result.backupId}`);
      throw new ExitSignal(0);
    });

  gateway
    .command("uninstall")
    .description(
      "remove the gateway MCP entry from targets (re-sync to restore individual servers)",
    )
    .option("--targets <list>", "comma-separated targets (codex,claude,kimi)", parseTargetList)
    .addOption(scopeOption())
    .action(async (options: GatewaySetupOptions) => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const result = await uninstallGateway(workspace, defaultRegistry(), {
        targets: options.targets,
        scope: options.scope,
      });
      printDiagnostics(result.diagnostics);
      for (const entry of result.removed) out(`  removed ${entry}`);
      out("Gateway entry removed. Run `agentpack sync` to restore individual MCP servers.");
      throw new ExitSignal(0);
    });
}
