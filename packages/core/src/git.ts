import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitSource } from "@agentpack/schema";
import { resolveInside, sha256, writeFileAtomic } from "@agentpack/filesystem";

const execFileAsync = promisify(execFile);

export interface LockfileSource {
  url: string;
  ref?: string;
  commit: string;
  subdirectory?: string;
}

export interface AgentpackLockfile {
  version: 1;
  sources: Record<string, LockfileSource>;
}

export function emptyLockfile(): AgentpackLockfile {
  return { version: 1, sources: {} };
}

export function sourceKey(source: GitSource): string {
  return `${source.url}#${source.subdirectory ?? ""}`;
}

export async function readLockfile(workspaceRoot: string): Promise<AgentpackLockfile> {
  const lockPath = path.join(workspaceRoot, ".agentpack", "lock.json");
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as AgentpackLockfile;
    if (parsed.version !== 1 || typeof parsed.sources !== "object") return emptyLockfile();
    return parsed;
  } catch {
    return emptyLockfile();
  }
}

export async function writeLockfile(workspaceRoot: string, lock: AgentpackLockfile): Promise<void> {
  const lockPath = path.join(workspaceRoot, ".agentpack", "lock.json");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await writeFileAtomic(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

async function git(args: string[], cwd?: string): Promise<string> {
  // -c core.hooksPath=/dev/null ensures no repository hooks ever execute.
  const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

export interface GitCheckoutResult {
  packDir: string;
  commit: string;
  lockUpdated: boolean;
}

/**
 * Clone (or reuse a cached clone of) a git pack source, check out the locked
 * commit (or resolve the ref to an immutable commit and record it), and
 * return the validated pack directory. Never runs git hooks or install
 * scripts.
 */
export async function ensureGitCheckout(
  workspaceRoot: string,
  source: GitSource,
  lockfile: AgentpackLockfile,
  update: boolean,
): Promise<GitCheckoutResult> {
  const key = sourceKey(source);
  const cacheKey = sha256(key).slice("sha256:".length, "sha256:".length + 16);
  const cacheDir = path.join(workspaceRoot, ".agentpack", "cache", "git", cacheKey);
  const locked = lockfile.sources[key];

  const exists = await fs.stat(path.join(cacheDir, ".git")).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await fs.mkdir(path.dirname(cacheDir), { recursive: true });
    await git(["clone", "--quiet", "--no-tags", source.url, cacheDir]);
  } else {
    await git(["fetch", "--quiet", "origin"], cacheDir);
  }

  let commit: string;
  let lockUpdated = false;
  if (locked && !update) {
    commit = locked.commit;
  } else {
    const ref = source.ref ?? "HEAD";
    commit = await git(["rev-parse", `${ref}^{commit}`], cacheDir);
    lockfile.sources[key] = {
      url: source.url,
      ref: source.ref,
      commit,
      subdirectory: source.subdirectory,
    };
    lockUpdated = true;
  }

  await git(["checkout", "--quiet", "--detach", commit], cacheDir);

  const packDir = source.subdirectory ? resolveInside(cacheDir, source.subdirectory) : cacheDir;
  const stat = await fs.stat(packDir).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new Error(`subdirectory not found in checkout: ${source.subdirectory ?? "."}`);
  }
  return { packDir, commit, lockUpdated };
}
