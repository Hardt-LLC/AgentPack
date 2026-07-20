import type { Command } from "commander";

import { watchWorkspace } from "@agentpack/core";
import type { InstallMode, Scope, Strictness, TargetId } from "@agentpack/schema";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { CliError, ExitSignal } from "../errors.js";
import {
  adapterOptionsOf,
  kimiPathStrategyOption,
  modeOption,
  parseTargetList,
  scopeOption,
  strictnessOption,
  targetOption,
} from "../options.js";
import { err, out } from "../output.js";
import { defaultRegistry } from "../registry.js";

interface WatchCommandOptions extends GlobalOptions {
  profile?: string;
  target?: TargetId;
  targets?: TargetId[];
  scope?: Scope;
  mode?: InstallMode;
  strictness?: Strictness;
  debounce?: string;
  collect?: boolean;
  kimiPathStrategy?: string;
}

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("watch packs and re-synchronize on change (Ctrl-C to stop)")
    .option("--profile <name>", "profile to sync")
    .addOption(targetOption())
    .option("--targets <list>", "comma-separated targets (codex,claude,kimi)", parseTargetList)
    .addOption(scopeOption())
    .addOption(modeOption())
    .addOption(strictnessOption())
    .option("--debounce <ms>", "debounce window in milliseconds", "400")
    .option("--collect", "also collect native changes into packs/inbox-<target>")
    .addOption(kimiPathStrategyOption())
    .action(async (options: WatchCommandOptions) => {
      if (options.target && options.targets && options.targets.length > 0) {
        throw new CliError("use either --target or --targets, not both", 2);
      }
      const targets = options.target ? [options.target] : options.targets;
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const debounceMs = Number.parseInt(options.debounce ?? "400", 10);
      if (!Number.isFinite(debounceMs) || debounceMs < 50) {
        throw new CliError("--debounce must be a number >= 50", 2);
      }

      const abort = new AbortController();
      process.on("SIGINT", () => abort.abort());
      process.on("SIGTERM", () => abort.abort());

      await watchWorkspace(workspace.rootDir, defaultRegistry(), {
        profile: options.profile,
        targets,
        scope: options.scope,
        installMode: options.mode,
        strictness: options.strictness,
        adapterOptions: adapterOptionsOf(options),
        debounceMs,
        collect: options.collect === true,
        signal: abort.signal,
        onEvent: (event) => {
          const time = new Date().toISOString().slice(11, 19);
          if (event.type === "changed") return; // too chatty; the sync line follows
          const line = `[${time}] ${event.message}`;
          if (event.type === "error" || event.type === "refused" || event.type === "conflict") {
            err(line);
          } else {
            out(line);
          }
        },
      });
      out("watch stopped.");
      throw new ExitSignal(0);
    });
}
