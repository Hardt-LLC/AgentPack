import path from "node:path";

import {
  findWorkspaceRoot,
  loadWorkspace,
  type LoadWorkspaceOptions,
  type LoadWorkspaceResult,
} from "@agentpack/core";

import { CliError } from "./errors.js";

export interface GlobalOptions {
  workspace?: string;
}

/**
 * Resolve the workspace root: explicit --workspace, otherwise walk up from
 * the current directory. Throws CliError (exit 2) when there is none.
 */
export async function resolveWorkspaceRoot(options: GlobalOptions): Promise<string> {
  if (options.workspace) return path.resolve(options.workspace);
  const root = await findWorkspaceRoot(process.cwd());
  if (!root) {
    throw new CliError(
      "no agentpack.yaml found — run inside a workspace or pass --workspace <dir>",
      2,
    );
  }
  return root;
}

/** Resolve the root and load the workspace (manifest + packs). */
export async function loadCliWorkspace(
  options: GlobalOptions,
  loadOptions: LoadWorkspaceOptions = {},
): Promise<LoadWorkspaceResult> {
  const rootDir = await resolveWorkspaceRoot(options);
  return loadWorkspace(rootDir, loadOptions);
}
