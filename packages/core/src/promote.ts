import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { Diagnostic } from "@agentpack/schema";
import { loadState, saveState, writeFileAtomic } from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { loadWorkspace, WORKSPACE_FILE, type LoadWorkspaceResult } from "./load-workspace.js";
import { syncWorkspace } from "./sync.js";
import { trustRequirement } from "./trust.js";

/**
 * One-command review→share: take an inbox pack (or any workspace pack),
 * add it to the `default` profile, grant trust for its executable
 * components, and sync it out to the profile's targets.
 */

export interface PromoteOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  dryRun?: boolean;
}

export interface PromoteResult {
  promoted: string;
  profileUpdated: boolean;
  trustGranted: boolean;
  synced: boolean;
  diagnostics: Diagnostic[];
}

/**
 * Promote `packName` into the default profile and sync. Returns diagnostics
 * instead of throwing for expected failures (unknown pack, no default
 * profile).
 */
export async function promotePack(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  packName: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const diagnostics: Diagnostic[] = [];
  const result: PromoteResult = {
    promoted: packName,
    profileUpdated: false,
    trustGranted: false,
    synced: false,
    diagnostics,
  };

  const loaded = workspace.packs.find((p) => p.pack?.metadata.name === packName);
  if (!loaded?.pack) {
    diagnostics.push({
      severity: "error",
      message: `pack "${packName}" not found in workspace (available: ${
        workspace.packs.flatMap((p) => (p.pack ? [p.pack.metadata.name] : [])).join(", ") || "none"
      })`,
    });
    return result;
  }
  const pack = loaded.pack;

  if (!workspace.manifest?.profiles["default"]) {
    diagnostics.push({
      severity: "error",
      message: 'no "default" profile in agentpack.yaml — add one before promoting',
      source: path.join(workspace.rootDir, WORKSPACE_FILE),
    });
    return result;
  }

  const requirement = await trustRequirement(pack);

  if (opts.dryRun) {
    if (!workspace.manifest.profiles["default"]!.packs.includes(packName)) {
      diagnostics.push({
        severity: "info",
        message: `would add "${packName}" to the default profile`,
      });
    }
    diagnostics.push({ severity: "info", message: `would grant trust for "${packName}"` });
    const syncResult = await syncWorkspace(workspace, registry, {
      env: opts.env,
      homeDir: opts.homeDir,
      dryRun: true,
      trust: [packName],
    });
    diagnostics.push(...syncResult.diagnostics);
    return result;
  }

  /* --------------------------- profile update --------------------------- */

  const workspaceFile = path.join(workspace.rootDir, WORKSPACE_FILE);
  const yamlText = await fs.readFile(workspaceFile, "utf8");
  const doc = parseYaml(yamlText) as Record<string, unknown>;
  const profiles = (doc.profiles ?? {}) as Record<string, { packs?: string[] }>;
  const defaultProfile = profiles["default"];
  if (!defaultProfile || !Array.isArray(defaultProfile.packs)) {
    diagnostics.push({
      severity: "error",
      message: 'no "default" profile in agentpack.yaml — add one before promoting',
      source: workspaceFile,
    });
    return result;
  }
  if (!defaultProfile.packs.includes(packName)) {
    defaultProfile.packs.push(packName);
    doc.profiles = profiles;
    await writeFileAtomic(workspaceFile, stringifyYaml(doc));
    result.profileUpdated = true;
    diagnostics.push({
      severity: "info",
      message: `added "${packName}" to the default profile`,
    });
  }

  /* ---------------------------- trust grant ----------------------------- */

  const state = await loadState(workspace.rootDir);
  state.trust = state.trust ?? {};
  state.trust[packName] = {
    contentHash: requirement.contentHash,
    grantedAt: new Date().toISOString(),
  };
  await saveState(workspace.rootDir, state);
  result.trustGranted = true;

  /* -------------------------------- sync -------------------------------- */

  // Reload so the updated profile drives the selection.
  const reloaded = await loadWorkspace(workspace.rootDir);
  const syncResult = await syncWorkspace(reloaded, registry, {
    env: opts.env,
    homeDir: opts.homeDir,
  });
  diagnostics.push(...syncResult.diagnostics);
  result.synced = syncResult.applied;
  return result;
}
