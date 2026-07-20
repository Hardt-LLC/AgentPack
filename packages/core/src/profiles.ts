import type { Diagnostic, InstallMode, Scope, TargetId } from "@agentpack/schema";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface ResolvedSelection {
  packs: import("@agentpack/schema").CanonicalPack[];
  targets: TargetId[];
  scope: Scope;
  installMode: InstallMode;
  profileName?: string;
  diagnostics: Diagnostic[];
}

export interface SelectionOverrides {
  profile?: string;
  targets?: TargetId[];
  scope?: Scope;
  installMode?: InstallMode;
}

/**
 * Resolve which packs/targets/scope a command operates on: explicit profile,
 * the `default` profile, or (when no profiles exist) every pack and target.
 */
export function resolveSelection(
  workspace: LoadWorkspaceResult,
  overrides: SelectionOverrides,
  allTargets: readonly TargetId[],
): ResolvedSelection {
  const diagnostics: Diagnostic[] = [];
  const available = new Map<string, import("@agentpack/schema").CanonicalPack>();
  for (const result of workspace.packs) {
    if (result.pack) available.set(result.pack.metadata.name, result.pack);
  }

  let packNames: string[];
  let targets: TargetId[];
  let scope: Scope = "project";
  let installMode: InstallMode = "auto";
  let profileName: string | undefined;

  const profiles = workspace.manifest?.profiles ?? {};
  const profile = overrides.profile ? profiles[overrides.profile] : profiles["default"];

  if (overrides.profile && !profile) {
    diagnostics.push({
      severity: "error",
      message: `profile not found: ${overrides.profile} (available: ${Object.keys(profiles).join(", ") || "none"})`,
    });
    packNames = [];
    targets = [];
  } else if (profile) {
    profileName = overrides.profile ?? "default";
    packNames = profile.packs;
    targets = profile.targets;
    scope = profile.scope;
    installMode = profile.installMode;
  } else {
    packNames = [...available.keys()];
    targets = [...allTargets];
  }

  if (overrides.targets) targets = overrides.targets;
  if (overrides.scope) scope = overrides.scope;
  if (overrides.installMode) installMode = overrides.installMode;

  const packs: import("@agentpack/schema").CanonicalPack[] = [];
  for (const name of packNames) {
    const pack = available.get(name);
    if (!pack) {
      diagnostics.push({
        severity: "error",
        message: `pack "${name}" referenced by profile but not found in workspace`,
      });
      continue;
    }
    packs.push(pack);
  }

  // Filter out packs disabled for every selected target.
  const selected = packs.filter((pack) => targets.some((t) => pack.targetEnabled[t] !== false));

  return { packs: selected, targets, scope, installMode, profileName, diagnostics };
}
