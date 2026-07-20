import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Create a directory and all missing parents. */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Write a file atomically: write to a temp file in the same directory, fsync,
 * then rename over the target. When no mode is given and the target exists,
 * its mode is preserved. The temp file is cleaned up on error.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  opts?: { mode?: number },
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let mode = opts?.mode;
  if (mode === undefined) {
    try {
      mode = (await fs.stat(filePath)).mode & 0o777;
    } catch {
      // Target does not exist yet; use the default mode.
    }
  }
  try {
    const handle = await fs.open(tmpPath, "w", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Read a UTF-8 file, returning undefined when it does not exist. */
export async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** True when the path exists (a dangling symlink counts as existing). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** True when the path exists and is a symlink. */
export async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}
