import { Command, CommanderError } from "commander";
import { redactSecrets } from "@agentpack/schema";

import { registerBuild } from "./commands/build.js";
import { registerCollect } from "./commands/collect.js";
import { registerDiff } from "./commands/diff.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerGateway } from "./commands/gateway.js";
import { registerHooks } from "./commands/hooks.js";
import { registerImport } from "./commands/import.js";
import { registerInit } from "./commands/init.js";
import { registerList } from "./commands/list.js";
import { registerPlan } from "./commands/plan.js";
import { registerPromote } from "./commands/promote.js";
import { registerRemove } from "./commands/remove.js";
import { registerRollback } from "./commands/rollback.js";
import { registerService } from "./commands/service.js";
import { registerSetup } from "./commands/setup.js";
import { registerSync } from "./commands/sync.js";
import { registerUninstall } from "./commands/uninstall.js";
import { registerUpdate } from "./commands/update.js";
import { registerValidate } from "./commands/validate.js";
import { registerWatch } from "./commands/watch.js";
import { CliError, ExitSignal } from "./errors.js";

const program = new Command();

program
  .name("agentpack")
  .description("Cross-agent extension package manager (targets: codex, claude, kimi)")
  .version("0.1.0")
  .option("--workspace <dir>", "workspace root (default: nearest agentpack.yaml)")
  .exitOverride();

registerInit(program);
registerValidate(program);
registerPlan(program);
registerSync(program);
registerBuild(program);
registerDiff(program);
registerDoctor(program);
registerList(program);
registerImport(program);
registerCollect(program);
registerPromote(program);
registerRemove(program);
registerRollback(program);
registerUpdate(program);
registerWatch(program);
registerGateway(program);
registerService(program);
registerSetup(program);
registerHooks(program);
registerUninstall(program);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof ExitSignal) {
      process.exit(error.code);
    }
    if (error instanceof CommanderError) {
      // Commander already printed help/usage. Map usage errors to exit 2.
      process.exit(error.exitCode === 0 ? 0 : 2);
    }
    if (error instanceof CliError) {
      if (error.message) {
        process.stderr.write(`${redactSecrets(`error: ${error.message}`)}\n`);
      }
      process.exit(error.exitCode);
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${redactSecrets(`error: ${message}`)}\n`);
    process.exit(2);
  }
}

await main();
