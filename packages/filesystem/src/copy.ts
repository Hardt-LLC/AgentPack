import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, isSymlink } from "./atomic.js";
import { PathEscapeError, isPathInside } from "./paths.js";

/**
 * Recursively copy a directory. Symlinks pointing inside the source tree are
 * reproduced as symlinks; symlinks pointing outside the source tree are
 * refused with a PathEscapeError. Existing destination files that are part of
 * the copy set are overwritten. Executable bits are preserved.
 */
export async function copyDirectory(source: string, dest: string): Promise<void> {
  const realSource = await fs.realpath(source);
  await ensureDir(dest);
  const dirents = await fs.readdir(source, { withFileTypes: true });
  for (const dirent of dirents) {
    const srcPath = path.join(source, dirent.name);
    const destPath = path.join(dest, dirent.name);
    if (dirent.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (dirent.isSymbolicLink()) {
      const real = await fs.realpath(srcPath);
      if (!isPathInside(realSource, real)) {
        throw new PathEscapeError(`symlink points outside the source tree: ${srcPath}`);
      }
      const target = await fs.readlink(srcPath);
      await fs.rm(destPath, { force: true, recursive: true });
      await fs.symlink(target, destPath);
    } else if (dirent.isFile()) {
      const stat = await fs.stat(srcPath);
      await fs.copyFile(srcPath, destPath);
      await fs.chmod(destPath, stat.mode & 0o777);
    }
    // Other entry types (sockets, fifos, ...) are skipped.
  }
}

/**
 * Remove a directory tree (rm -rf equivalent). Refuses to operate on a
 * symlink or on a filesystem root.
 */
export async function removeDirectoryRecursive(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  if (resolved === path.parse(resolved).root) {
    throw new PathEscapeError(`refusing to remove a filesystem root: ${targetPath}`);
  }
  if (await isSymlink(targetPath)) {
    throw new PathEscapeError(`refusing to remove a symlink: ${targetPath}`);
  }
  await fs.rm(targetPath, { recursive: true, force: true });
}

/**
 * Create a symlink at linkPath pointing at target. An existing symlink at
 * linkPath is replaced; an existing non-symlink path is a conflict and throws.
 */
export async function createSymlink(target: string, linkPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      await fs.rm(linkPath, { force: true });
    } else {
      throw new Error(
        `cannot create symlink at ${linkPath}: an existing non-symlink path conflicts`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await ensureDir(path.dirname(linkPath));
  const type = process.platform === "win32" ? "junction" : undefined;
  await fs.symlink(target, linkPath, type);
}

/** True when resolving the path hits a symlink loop (ELOOP). */
export async function detectSymlinkLoop(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ELOOP";
  }
}
