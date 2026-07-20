import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBackup, listBackups, pruneBackups, restoreBackup } from "../src/index.js";

let tmpDir: string;
let backupsDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-backup-")));
  backupsDir = path.join(tmpDir, "backups");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createBackup / restoreBackup", () => {
  it("round-trips files, directories and deletions", async () => {
    const file = path.join(tmpDir, "file.txt");
    const dir = path.join(tmpDir, "dir");
    const absent = path.join(tmpDir, "absent.txt");
    await fs.writeFile(file, "original");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "inner.txt"), "inner");

    const backup = await createBackup(backupsDir, [file, dir, absent], "test");
    expect(backup.id.startsWith("test-")).toBe(true);
    const manifest = JSON.parse(
      await fs.readFile(path.join(backup.dir, "manifest.json"), "utf8"),
    ) as { id: string; entries: Array<{ existed: boolean }> };
    expect(manifest.id).toBe(backup.id);
    expect(manifest.entries.map((e) => e.existed)).toEqual([true, true, false]);

    // Mutate the live state: change file, delete dir, create the absent file.
    await fs.writeFile(file, "modified");
    await fs.rm(dir, { recursive: true });
    await fs.writeFile(absent, "created later");

    const restored = await restoreBackup(backup.dir);
    expect(restored).toEqual([file, dir, absent]);
    expect(await fs.readFile(file, "utf8")).toBe("original");
    expect(await fs.readFile(path.join(dir, "inner.txt"), "utf8")).toBe("inner");
    // The file that did not exist at backup time is removed again.
    await expect(fs.stat(absent)).rejects.toThrow();
  });
});

describe("listBackups / pruneBackups", () => {
  it("lists newest first and prunes the rest", async () => {
    expect(await listBackups(backupsDir)).toEqual([]);

    const first = await createBackup(backupsDir, []);
    // Ensure a distinct, later createdAt.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createBackup(backupsDir, []);

    const listed = await listBackups(backupsDir);
    expect(listed.map((b) => b.id)).toEqual([second.id, first.id]);
    expect(listed[0]!.createdAt >= listed[1]!.createdAt).toBe(true);

    await pruneBackups(backupsDir, 1);
    const remaining = await listBackups(backupsDir);
    expect(remaining.map((b) => b.id)).toEqual([second.id]);

    await pruneBackups(backupsDir, 0);
    expect(await listBackups(backupsDir)).toEqual([]);
  });
});
