import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  packManifestSchema,
  workspaceManifestSchema,
  type Diagnostic,
  type PackManifest,
  type WorkspaceManifest,
} from "@agentpack/schema";
import { computeWorkspaceId, resolveInside } from "@agentpack/filesystem";
import { loadPack, type LoadPackResult } from "./load-pack.js";
import { ensureGitCheckout, readLockfile, writeLockfile } from "./git.js";

export const WORKSPACE_FILE = "agentpack.yaml";
export const STATE_DIR = ".agentpack";

export interface LoadWorkspaceResult {
  rootDir: string;
  manifest: WorkspaceManifest | undefined;
  packs: LoadPackResult[];
  diagnostics: Diagnostic[];
  workspaceId: string;
}

/** Walk upward from startDir looking for agentpack.yaml. */
export async function findWorkspaceRoot(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const stat = await fs.stat(path.join(dir, WORKSPACE_FILE));
      if (stat.isFile()) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function zodDiagnostics(error: unknown, source: string): Diagnostic[] {
  const err = error as { issues?: Array<{ path: (string | number)[]; message: string }> };
  if (!err.issues) return [{ severity: "error", message: String(error), source }];
  return err.issues.map((issue) => ({
    severity: "error" as const,
    message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    source,
  }));
}

export function parseWorkspaceManifest(yamlText: string, source: string) {
  const diagnostics: Diagnostic[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    return {
      manifest: undefined,
      diagnostics: [
        {
          severity: "error" as const,
          message: `invalid YAML: ${(error as Error).message}`,
          source,
        },
      ],
    };
  }
  const parsed = workspaceManifestSchema.safeParse(raw);
  if (!parsed.success) {
    diagnostics.push(...zodDiagnostics(parsed.error, source));
    return { manifest: undefined, diagnostics };
  }
  return { manifest: parsed.data, diagnostics };
}

export function parsePackManifest(
  yamlText: string,
  source: string,
): {
  manifest: PackManifest | undefined;
  diagnostics: Diagnostic[];
} {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    return {
      manifest: undefined,
      diagnostics: [
        {
          severity: "error" as const,
          message: `invalid YAML: ${(error as Error).message}`,
          source,
        },
      ],
    };
  }
  const parsed = packManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { manifest: undefined, diagnostics: zodDiagnostics(parsed.error, source) };
  }
  return { manifest: parsed.data, diagnostics: [] };
}

export interface LoadWorkspaceOptions {
  /** Update git checkouts to the newest ref instead of using the lockfile. */
  updateGitSources?: boolean;
}

/**
 * Load a workspace: parse agentpack.yaml, resolve all pack sources
 * (local paths and git checkouts), and load every pack.
 */
export async function loadWorkspace(
  rootDir: string,
  opts: LoadWorkspaceOptions = {},
): Promise<LoadWorkspaceResult> {
  const diagnostics: Diagnostic[] = [];
  const packs: LoadPackResult[] = [];
  rootDir = path.resolve(rootDir);

  const manifestPath = path.join(rootDir, WORKSPACE_FILE);
  let yamlText: string;
  try {
    yamlText = await fs.readFile(manifestPath, "utf8");
  } catch {
    return {
      rootDir,
      manifest: undefined,
      packs,
      workspaceId: "",
      diagnostics: [
        {
          severity: "error",
          message: `workspace file not found: ${manifestPath}`,
          source: manifestPath,
        },
      ],
    };
  }

  const { manifest, diagnostics: manifestDiags } = parseWorkspaceManifest(yamlText, manifestPath);
  diagnostics.push(...manifestDiags);
  const workspaceId = computeWorkspaceId(rootDir, yamlText);
  if (!manifest) return { rootDir, manifest, packs, diagnostics, workspaceId };

  const lockfile = await readLockfile(rootDir);
  let lockChanged = false;

  for (const source of manifest.packs) {
    if ("path" in source) {
      let packDir: string;
      try {
        packDir = resolveInside(rootDir, source.path);
      } catch (error) {
        diagnostics.push({
          severity: "error",
          message: (error as Error).message,
          source: source.path,
        });
        continue;
      }
      const stat = await fs.stat(packDir).catch(() => undefined);
      if (!stat?.isDirectory()) {
        diagnostics.push({
          severity: "error",
          message: `pack directory not found: ${source.path}`,
          source: source.path,
        });
        continue;
      }
      packs.push(await loadPack(packDir));
      continue;
    }

    // Git source
    try {
      const result = await ensureGitCheckout(
        rootDir,
        source.source,
        lockfile,
        opts.updateGitSources === true,
      );
      if (result.lockUpdated) lockChanged = true;
      packs.push(await loadPack(result.packDir));
    } catch (error) {
      diagnostics.push({
        severity: "error",
        message: `git source ${source.source.url}: ${(error as Error).message}`,
        source: source.source.url,
      });
    }
  }

  if (lockChanged) await writeLockfile(rootDir, lockfile);

  // Duplicate pack names
  const seen = new Map<string, number>();
  for (const pack of packs) {
    const name = pack.manifest?.metadata.name;
    if (!name) continue;
    if (seen.has(name)) {
      diagnostics.push({
        severity: "error",
        message: `duplicate pack name: ${name}`,
        source: pack.rootDir,
      });
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }

  return { rootDir, manifest, packs, diagnostics, workspaceId };
}
