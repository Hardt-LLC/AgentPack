import type { Command } from "commander";

import { detectTargets } from "@agentpack/core";
import { loadState } from "@agentpack/filesystem";

import { loadCliWorkspace, type GlobalOptions } from "../context.js";
import { ExitSignal } from "../errors.js";
import { out } from "../output.js";
import { defaultRegistry } from "../registry.js";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("list packs, profiles, detected targets and sync status")
    .action(async () => {
      const workspace = await loadCliWorkspace(program.opts<GlobalOptions>());
      const registry = defaultRegistry();
      const detected = await detectTargets(registry, workspace.rootDir);
      const state = await loadState(workspace.rootDir);

      out("Packs:");
      if (workspace.packs.length === 0) out("  (none)");
      for (const loaded of workspace.packs) {
        const pack = loaded.pack;
        if (!pack) {
          out(`  - ${loaded.rootDir} (failed to load)`);
          continue;
        }
        out(
          `  - ${pack.metadata.name} ${pack.metadata.version}${pack.metadata.description ? ` — ${pack.metadata.description}` : ""}`,
        );
        out(`    skills: ${pack.skills.map((s) => s.name).join(", ") || "(none)"}`);
        out(`    mcp servers: ${Object.keys(pack.mcpServers).join(", ") || "(none)"}`);
      }

      out("");
      out("Profiles:");
      const profiles = workspace.manifest?.profiles ?? {};
      const profileEntries = Object.entries(profiles);
      if (profileEntries.length === 0) out("  (none)");
      for (const [name, profile] of profileEntries) {
        out(
          `  - ${name}: packs=[${profile.packs.join(", ")}] targets=[${profile.targets.join(", ")}] ` +
            `scope=${profile.scope} installMode=${profile.installMode}`,
        );
      }

      out("");
      out("Detected targets:");
      for (const adapter of registry.all()) {
        const detection = detected[adapter.id];
        out(`  - ${adapter.id}: ${detection?.installed ? "installed" : "not installed"}`);
      }

      out("");
      out("Sync status:");
      out(`  lastSyncAt: ${state.lastSyncAt ?? "never"}`);
      const targetEntries = Object.entries(state.targets);
      if (targetEntries.length === 0) out("  (no target state)");
      for (const [target, targetState] of targetEntries) {
        out(
          `  - ${target}: ${targetState.ownedFiles.length} owned files, ` +
            `${targetState.ownedConfigKeys.length} owned config keys`,
        );
      }
      throw new ExitSignal(0);
    });
}
