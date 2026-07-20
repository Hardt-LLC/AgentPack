import fs from "node:fs/promises";

import { isSymlink, pathExists, readFileIfExists, writeFileAtomic } from "./atomic.js";
import { copyDirectory, createSymlink, removeDirectoryRecursive } from "./copy.js";
import { hashDirectory } from "./hash.js";
import { mergeJsonAtPointer } from "./json-merge.js";
import { upsertManagedSection } from "./markdown-section.js";
import { mergeTomlAtTable } from "./toml-merge.js";

export type InstallOperation =
  | { type: "writeFile"; path: string; content: string; executable?: boolean }
  | { type: "mergeJson"; path: string; pointer: string; value: unknown }
  | { type: "mergeToml"; path: string; table: string[]; value: unknown }
  | {
      type: "managedMarkdownSection";
      path: string;
      sectionId: string;
      content: string;
      append?: boolean;
    }
  | { type: "createSymlink"; path: string; target: string }
  | { type: "copyDirectory"; source: string; dest: string }
  | { type: "removeOwnedPath"; path: string };

export type OperationAction = "create" | "update" | "noop" | "remove";

export interface PlannedOperation {
  operation: InstallOperation;
  action: OperationAction;
  detail: string;
}

/** A short human description of an install operation. */
export function describeOperation(op: InstallOperation): string {
  switch (op.type) {
    case "writeFile":
      return `write file ${op.path}`;
    case "mergeJson":
      return `merge JSON at ${op.pointer} in ${op.path}`;
    case "mergeToml":
      return `merge TOML table [${op.table.join(".")}] in ${op.path}`;
    case "managedMarkdownSection":
      return `upsert managed section "${op.sectionId}" in ${op.path}`;
    case "createSymlink":
      return `symlink ${op.path} -> ${op.target}`;
    case "copyDirectory":
      return `copy directory ${op.source} -> ${op.dest}`;
    case "removeOwnedPath":
      return `remove ${op.path}`;
  }
}

function planned(operation: InstallOperation, action: OperationAction, detail: string) {
  return { operation, action, detail };
}

async function planOne(op: InstallOperation): Promise<PlannedOperation> {
  switch (op.type) {
    case "writeFile": {
      const existing = await readFileIfExists(op.path);
      if (existing === undefined) return planned(op, "create", `create ${op.path}`);
      if (existing === op.content) return planned(op, "noop", `${op.path} is up to date`);
      return planned(op, "update", `update ${op.path} (content differs)`);
    }
    case "mergeJson": {
      const existing = await readFileIfExists(op.path);
      const merged = mergeJsonAtPointer(existing, op.pointer, op.value);
      if (existing === undefined) {
        return planned(op, "create", `create ${op.path} with ${op.pointer}`);
      }
      if (merged === existing)
        return planned(op, "noop", `${op.pointer} in ${op.path} is up to date`);
      return planned(op, "update", `update ${op.pointer} in ${op.path} (content differs)`);
    }
    case "mergeToml": {
      const existing = await readFileIfExists(op.path);
      const merged = mergeTomlAtTable(existing, op.table, op.value);
      if (existing === undefined) {
        return planned(op, "create", `create ${op.path} with [${op.table.join(".")}]`);
      }
      if (merged === existing) {
        return planned(op, "noop", `[${op.table.join(".")}] in ${op.path} is up to date`);
      }
      return planned(
        op,
        "update",
        `update [${op.table.join(".")}] in ${op.path} (content differs)`,
      );
    }
    case "managedMarkdownSection": {
      const existing = await readFileIfExists(op.path);
      const next = upsertManagedSection(existing, op.sectionId, op.content);
      if (existing === undefined) {
        return planned(op, "create", `create ${op.path} with section "${op.sectionId}"`);
      }
      if (next === existing) {
        return planned(op, "noop", `section "${op.sectionId}" in ${op.path} is up to date`);
      }
      return planned(
        op,
        "update",
        `update section "${op.sectionId}" in ${op.path} (content differs)`,
      );
    }
    case "createSymlink": {
      if (await isSymlink(op.path)) {
        const current = await fs.readlink(op.path);
        if (current === op.target) {
          return planned(op, "noop", `${op.path} already links to ${op.target}`);
        }
        return planned(op, "update", `update symlink ${op.path} (-> ${op.target})`);
      }
      if (await pathExists(op.path)) {
        return planned(op, "update", `update ${op.path} (conflicts with an existing path)`);
      }
      return planned(op, "create", `create symlink ${op.path} -> ${op.target}`);
    }
    case "copyDirectory": {
      if (!(await pathExists(op.dest))) {
        return planned(op, "create", `create ${op.dest} from ${op.source}`);
      }
      const destStat = await fs.stat(op.dest).catch(() => undefined);
      if (!destStat?.isDirectory()) {
        return planned(op, "update", `update ${op.dest} (existing path is not a directory)`);
      }
      const [sourceHash, destHash] = await Promise.all([
        hashDirectory(op.source),
        hashDirectory(op.dest),
      ]);
      if (sourceHash === destHash) return planned(op, "noop", `${op.dest} is up to date`);
      return planned(op, "update", `update ${op.dest} (content differs)`);
    }
    case "removeOwnedPath": {
      if (await pathExists(op.path)) return planned(op, "remove", `remove ${op.path}`);
      return planned(op, "noop", `${op.path} is already absent`);
    }
  }
}

/**
 * Compare desired operations to the filesystem without modifying anything,
 * reporting whether each would create, update, remove or leave things as-is.
 */
export async function planOperations(ops: InstallOperation[]): Promise<PlannedOperation[]> {
  const result: PlannedOperation[] = [];
  for (const op of ops) {
    result.push(await planOne(op));
  }
  return result;
}

/**
 * Apply install operations sequentially. A removeOwnedPath is refused (and
 * throws) when opts.guardRemove returns false for its path.
 */
export async function applyOperations(
  ops: InstallOperation[],
  opts?: { guardRemove?: (path: string) => boolean },
): Promise<void> {
  for (const op of ops) {
    switch (op.type) {
      case "writeFile":
        await writeFileAtomic(op.path, op.content, op.executable ? { mode: 0o755 } : undefined);
        break;
      case "mergeJson": {
        const existing = await readFileIfExists(op.path);
        await writeFileAtomic(op.path, mergeJsonAtPointer(existing, op.pointer, op.value));
        break;
      }
      case "mergeToml": {
        const existing = await readFileIfExists(op.path);
        await writeFileAtomic(op.path, mergeTomlAtTable(existing, op.table, op.value));
        break;
      }
      case "managedMarkdownSection": {
        const existing = await readFileIfExists(op.path);
        await writeFileAtomic(op.path, upsertManagedSection(existing, op.sectionId, op.content));
        break;
      }
      case "createSymlink":
        await createSymlink(op.target, op.path);
        break;
      case "copyDirectory":
        await copyDirectory(op.source, op.dest);
        break;
      case "removeOwnedPath": {
        if (opts?.guardRemove && !opts.guardRemove(op.path)) {
          throw new Error(`refusing to remove a path that is not owned: ${op.path}`);
        }
        const stat = await fs.lstat(op.path).catch(() => undefined);
        if (!stat) break;
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await removeDirectoryRecursive(op.path);
        } else {
          await fs.rm(op.path, { force: true });
        }
        break;
      }
    }
  }
}
