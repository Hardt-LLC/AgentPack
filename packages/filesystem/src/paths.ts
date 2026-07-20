import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/** Thrown when a path would escape its allowed root. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/** Convert path separators to "/". */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Normalize a relative path to a canonical POSIX form without a leading "./".
 * Rejects absolute paths, empty segments and anything that escapes the root
 * ("../x", "a/../../b").
 */
export function normalizeRelativePath(rel: string): string {
  if (rel.length === 0) {
    throw new PathEscapeError("empty path is not allowed");
  }
  const posix = toPosixPath(rel);
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix) || path.isAbsolute(rel)) {
    throw new PathEscapeError(`absolute path is not allowed: ${rel}`);
  }
  const segments = posix.split("/");
  if (segments.some((seg) => seg === "")) {
    throw new PathEscapeError(`path contains an empty segment: ${rel}`);
  }
  const normalized = path.posix.normalize(posix);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new PathEscapeError(`path escapes its root: ${rel}`);
  }
  return normalized;
}

/** True when `p` is `root` itself or lives underneath it (textual comparison). */
export function isPathInside(root: string, p: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(p));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve `rel` against `root` to an absolute, normalized path.
 * Throws PathEscapeError when the result escapes `root`, either textually or
 * via a symlink ancestor that points outside `root`.
 */
export function resolveInside(root: string, rel: string): string {
  const normalizedRel = normalizeRelativePath(rel);
  const absRoot = path.resolve(root);
  const result = path.resolve(absRoot, normalizedRel);
  if (!isPathInside(absRoot, result)) {
    throw new PathEscapeError(`path escapes its root: ${rel}`);
  }

  // Symlink check: compare real paths so a symlink ancestor pointing outside
  // the root is caught. The root itself may live under a symlink (e.g. macOS
  // /var -> /private/var), so resolve the root first.
  let realRoot = absRoot;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    // Root does not exist yet; fall back to the textual root.
  }
  let nearest = result;
  for (;;) {
    try {
      const real = realpathSync(nearest);
      if (!isPathInside(realRoot, real)) {
        throw new PathEscapeError(`path resolves outside its root via a symlink: ${rel}`);
      }
      return result;
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      const parent = path.dirname(nearest);
      if (parent === nearest) return result;
      nearest = parent;
    }
  }
}

/** Sync existence check used internally. */
export function pathExistsSync(p: string): boolean {
  return existsSync(p);
}
