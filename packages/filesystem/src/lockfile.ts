import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, readFileIfExists } from "./atomic.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run `fn` while holding a process lock at lockPath. The lock file contains
 * the pid and is created with the "wx" flag. A lock held by a live process
 * fails with "another agentpack process is running"; a stale lock (dead pid
 * or unreadable content) is reclaimed. The lock is always released.
 */
export async function withProcessLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(path.dirname(lockPath));
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid), "utf8");
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pidText = await readFileIfExists(lockPath);
      const pid = Number(pidText?.trim());
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        throw new Error("another agentpack process is running");
      }
      // Stale lock: remove it and retry once.
      await fs.rm(lockPath, { force: true });
    }
  }
  if (!acquired) {
    throw new Error("another agentpack process is running");
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}
