import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, pathExists, readFileIfExists, writeFileAtomic } from "./atomic.js";
import { copyDirectory } from "./copy.js";

export interface BackupEntry {
  originalPath: string;
  /** Path of the stored copy, relative to the backup directory. */
  storedPath: string;
  existed: boolean;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  entries: BackupEntry[];
}

export interface BackupInfo {
  id: string;
  dir: string;
  createdAt: string;
}

function backupTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Snapshot the given paths into a new backup directory under backupsDir.
 * Each existing path (file, directory or symlink) is copied to
 * `<dir>/files/<index>` and a manifest.json describes the entries.
 */
export async function createBackup(
  backupsDir: string,
  paths: string[],
  idPrefix?: string,
): Promise<{ id: string; dir: string }> {
  const id = `${idPrefix ?? "backup"}-${backupTimestamp(new Date())}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(backupsDir, id);
  const filesDir = path.join(dir, "files");
  await ensureDir(filesDir);

  const entries: BackupEntry[] = [];
  for (let i = 0; i < paths.length; i++) {
    const originalPath = paths[i]!;
    const storedPath = path.join("files", String(i));
    const absoluteStored = path.join(dir, storedPath);
    const existed = await pathExists(originalPath);
    if (existed) {
      const stat = await fs.lstat(originalPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(originalPath);
        await fs.symlink(target, absoluteStored);
      } else if (stat.isDirectory()) {
        await copyDirectory(originalPath, absoluteStored);
      } else {
        await fs.copyFile(originalPath, absoluteStored);
        await fs.chmod(absoluteStored, stat.mode & 0o777);
      }
    }
    entries.push({ originalPath, storedPath, existed });
  }

  const manifest: BackupManifest = { id, createdAt: new Date().toISOString(), entries };
  await writeFileAtomic(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, dir };
}

/**
 * Restore a backup: copy each entry back to its original path (creating
 * parent directories) and remove paths that did not exist at backup time.
 * Returns the restored (or removed) original paths.
 */
export async function restoreBackup(dir: string): Promise<string[]> {
  const manifestContent = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestContent) as BackupManifest;
  const restored: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.existed) {
      const stored = path.join(dir, entry.storedPath);
      const stat = await fs.lstat(stored);
      await ensureDir(path.dirname(entry.originalPath));
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(stored);
        await fs.rm(entry.originalPath, { force: true, recursive: true });
        await fs.symlink(target, entry.originalPath);
      } else if (stat.isDirectory()) {
        await fs.rm(entry.originalPath, { force: true, recursive: true });
        await copyDirectory(stored, entry.originalPath);
      } else {
        await fs.copyFile(stored, entry.originalPath);
        await fs.chmod(entry.originalPath, stat.mode & 0o777);
      }
    } else {
      await fs.rm(entry.originalPath, { force: true, recursive: true });
    }
    restored.push(entry.originalPath);
  }
  return restored;
}

/** List backups under backupsDir, newest first. */
export async function listBackups(backupsDir: string): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(backupsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const backups: BackupInfo[] = [];
  for (const name of names) {
    const dir = path.join(backupsDir, name);
    const manifestContent = await readFileIfExists(path.join(dir, "manifest.json"));
    if (manifestContent === undefined) continue;
    try {
      const manifest = JSON.parse(manifestContent) as BackupManifest;
      backups.push({ id: manifest.id, dir, createdAt: manifest.createdAt });
    } catch {
      // Skip backups with an unreadable manifest.
    }
  }
  backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return backups;
}

/** Delete all but the newest `keep` backups. */
export async function pruneBackups(backupsDir: string, keep: number): Promise<void> {
  const backups = await listBackups(backupsDir);
  for (const backup of backups.slice(Math.max(keep, 0))) {
    await fs.rm(backup.dir, { recursive: true, force: true });
  }
}
