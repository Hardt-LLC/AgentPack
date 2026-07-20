import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { collectEnvVars, TARGET_IDS, type TargetId } from "@agentpack/schema";
import { detectSymlinkLoop, isSymlink, loadState, pathExists } from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { detectTargets, type DetectedTargets } from "./detect.js";
import { validateWorkspace } from "./validate.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  detected?: DetectedTargets;
}

/** Run environment and workspace health checks. Never prints secret values. */
export async function runDoctor(
  workspace: LoadWorkspaceResult | undefined,
  registry: AdapterRegistry,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const push = (name: string, status: DoctorCheck["status"], message: string) =>
    checks.push({ name, status, message });

  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  push(
    "node-version",
    major >= 20 ? "ok" : "error",
    major >= 20
      ? `Node ${process.versions.node}`
      : `Node ${process.versions.node} — AgentPack requires Node 20+`,
  );

  // Symlink capability
  try {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-doctor-"));
    const targetFile = path.join(tmp, "target");
    await fs.writeFile(targetFile, "x");
    await fs.symlink(targetFile, path.join(tmp, "link"));
    await fs.rm(tmp, { recursive: true, force: true });
    push("symlinks", "ok", "symlinks supported");
  } catch {
    push("symlinks", "warn", "symlinks unavailable — sync will use copy mode");
  }

  // Workspace
  if (!workspace?.manifest) {
    push("workspace", "error", "no valid agentpack.yaml found");
    return { checks, ok: false };
  }
  push("workspace", "ok", `workspace at ${workspace.rootDir}`);

  // Validation
  const detected =
    opts.detected ?? (await detectTargets(registry, workspace.rootDir, { env, homeDir }));
  const validation = await validateWorkspace(workspace, registry, detected, { env });
  const errorCount = validation.diagnostics.filter((d) => d.severity === "error").length;
  push(
    "workspace-validity",
    errorCount === 0 ? "ok" : "error",
    errorCount === 0 ? "workspace validates" : `${errorCount} validation error(s)`,
  );

  // Per-target detection, config roots and write permissions.
  for (const target of TARGET_IDS) {
    const detection = detected[target];
    if (!detection) continue;
    push(
      `detect:${target}`,
      detection.installed ? "ok" : "warn",
      detection.installed
        ? `installed${detection.version ? ` (${detection.version})` : ""}${detection.executablePath ? ` at ${detection.executablePath}` : ""}`
        : "not detected — sync will still generate config",
    );
    for (const warning of detection.warnings) {
      push(`detect:${target}`, "warn", warning);
    }
    const root = detection.userConfigRoot || detection.projectConfigRoot;
    if (root) {
      try {
        const probe = path.join(root, ".agentpack-write-probe");
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(probe, "");
        await fs.unlink(probe);
        push(`writable:${target}`, "ok", `${root} is writable`);
      } catch {
        push(`writable:${target}`, "error", `${root} is not writable`);
      }
    }
  }

  // Required environment-variable names (names only, never values).
  const requiredEnv = new Set<string>();
  for (const loaded of workspace.packs) {
    for (const server of Object.values(loaded.pack?.mcpServers ?? {})) {
      for (const v of collectEnvVars({ ...(server.env ?? {}), ...(server.headers ?? {}) })) {
        requiredEnv.add(v);
      }
      for (const v of server.passEnv ?? []) requiredEnv.add(v);
    }
  }
  for (const varName of [...requiredEnv].sort()) {
    push(
      `env:${varName}`,
      env[varName] === undefined ? "warn" : "ok",
      env[varName] === undefined ? `${varName} is not set` : `${varName} is set`,
    );
  }

  // State consistency, broken links, stale generated files.
  try {
    const state = await loadState(workspace.rootDir);
    push("state", "ok", "state.json is consistent");
    for (const [target, targetState] of Object.entries(state.targets)) {
      for (const owned of targetState.ownedFiles) {
        if (await detectSymlinkLoop(owned.path)) {
          push(`links:${target}`, "error", `symlink loop: ${owned.path}`);
          continue;
        }
        if ((await isSymlink(owned.path)) && !(await pathExists(owned.path))) {
          push(`links:${target}`, "warn", `broken symlink: ${owned.path}`);
          continue;
        }
        if (!(await pathExists(owned.path)) && !(await isSymlink(owned.path))) {
          push(`stale:${target}`, "warn", `owned path missing (re-run sync): ${owned.path}`);
        }
      }
    }
  } catch (error) {
    push("state", "error", `state.json is corrupt: ${(error as Error).message}`);
  }

  // Native config parse errors.
  for (const target of TARGET_IDS) {
    const detection = detected[target];
    for (const root of [detection?.projectConfigRoot, detection?.userConfigRoot]) {
      if (!root) continue;
      for (const candidate of [".mcp.json", "mcp.json"]) {
        const file = path.join(root, candidate);
        if (!(await pathExists(file))) continue;
        try {
          JSON.parse(await fs.readFile(file, "utf8"));
        } catch {
          push(`parse:${target}`, "error", `invalid JSON: ${file}`);
        }
      }
    }
  }

  const ok = checks.every((c) => c.status !== "error");
  return { checks, ok };
}

export type { TargetId };
