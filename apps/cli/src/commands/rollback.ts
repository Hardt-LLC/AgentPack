import type { Command } from "commander";

import { listAvailableBackups, rollback } from "@agentpack/core";

import { resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { err, out } from "../output.js";

interface RollbackOptions extends GlobalOptions {
  to?: string;
  list?: boolean;
}

export function registerRollback(program: Command): void {
  program
    .command("rollback")
    .description("restore the most recent backup (or a specific one with --to)")
    .option("--to <backup-id>", "restore a specific backup instead of the latest")
    .option("--list", "list available backups without restoring")
    .action(async (options: RollbackOptions) => {
      const root = await resolveWorkspaceRoot(program.opts<GlobalOptions>());

      if (options.list) {
        const backups = await listAvailableBackups(root);
        if (backups.length === 0) {
          out("No backups available.");
        } else {
          out("Backups (newest first):");
          for (const backup of backups) out(`  - ${backup.id}  ${backup.createdAt}`);
        }
        throw new ExitSignal(0);
      }

      let restored: string[];
      let backupId: string;
      try {
        const result = await rollback(root, options.to);
        restored = result.restored;
        backupId = result.backupId;
      } catch (error) {
        err(`rollback failed: ${(error as Error).message}`);
        const backups = await listAvailableBackups(root);
        if (backups.length > 0) {
          err("Available backups:");
          for (const backup of backups) err(`  - ${backup.id}  ${backup.createdAt}`);
        }
        throw new ExitSignal(2);
      }
      out(`Restored backup ${backupId}:`);
      for (const p of restored) out(`  - ${p}`);
      throw new ExitSignal(0);
    });
}
