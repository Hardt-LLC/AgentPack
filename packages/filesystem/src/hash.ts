import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { toPosixPath } from "./paths.js";

/** Hash content, returning "sha256:<hex>". */
export function sha256(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Hash a file's contents, returning "sha256:<hex>". */
export async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

/**
 * Hash a directory tree deterministically: the hash covers the sorted list of
 * (relativePath, fileHash) pairs. Symlinks contribute their link path string,
 * never their target.
 */
export async function hashDirectory(rootDir: string): Promise<string> {
  const entries: Array<{ rel: string; hash: string }> = [];
  await walk(rootDir, rootDir, entries);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.rel);
    hash.update("\0");
    hash.update(entry.hash);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function walk(
  rootDir: string,
  dir: string,
  out: Array<{ rel: string; hash: string }>,
): Promise<void> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    const rel = toPosixPath(path.relative(rootDir, full));
    if (dirent.isDirectory()) {
      await walk(rootDir, full, out);
    } else if (dirent.isSymbolicLink()) {
      const target = await fs.readlink(full);
      out.push({ rel, hash: sha256(`symlink:${target}`) });
    } else if (dirent.isFile()) {
      out.push({ rel, hash: await hashFile(full) });
    }
    // Anything else (sockets, fifos, ...) is skipped.
  }
}
