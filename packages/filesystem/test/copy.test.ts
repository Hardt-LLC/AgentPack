import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PathEscapeError,
  copyDirectory,
  createSymlink,
  detectSymlinkLoop,
  removeDirectoryRecursive,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-copy-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("copyDirectory", () => {
  it("copies nested files and preserves the executable bit", async () => {
    const src = path.join(tmpDir, "src");
    const dest = path.join(tmpDir, "dest");
    await fs.mkdir(path.join(src, "nested"), { recursive: true });
    await fs.writeFile(path.join(src, "nested", "a.txt"), "alpha");
    await fs.writeFile(path.join(src, "run.sh"), "#!/bin/sh\n");
    await fs.chmod(path.join(src, "run.sh"), 0o755);

    await copyDirectory(src, dest);

    expect(await fs.readFile(path.join(dest, "nested", "a.txt"), "utf8")).toBe("alpha");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(dest, "run.sh"))).mode & 0o111).not.toBe(0);
    } else {
      expect(await fs.readFile(path.join(dest, "run.sh"), "utf8")).toBe("#!/bin/sh\n");
    }
  });

  it("reproduces internal symlinks and refuses external ones", async () => {
    const src = path.join(tmpDir, "src");
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, "target.txt"), "t");
    await fs.symlink(path.join(src, "target.txt"), path.join(src, "internal-link"));

    const dest = path.join(tmpDir, "dest");
    await copyDirectory(src, dest);
    const linkStat = await fs.lstat(path.join(dest, "internal-link"));
    expect(linkStat.isSymbolicLink()).toBe(true);

    const outside = path.join(tmpDir, "outside.txt");
    await fs.writeFile(outside, "secret");
    await fs.symlink(outside, path.join(src, "external-link"));
    await expect(copyDirectory(src, path.join(tmpDir, "dest2"))).rejects.toThrow(PathEscapeError);
  });
});

describe("removeDirectoryRecursive", () => {
  it("removes a directory tree", async () => {
    const dir = path.join(tmpDir, "tree");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "f.txt"), "x");
    await removeDirectoryRecursive(dir);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("refuses to remove a symlink", async () => {
    const real = path.join(tmpDir, "real");
    await fs.mkdir(real, { recursive: true });
    const link = path.join(tmpDir, "link");
    await fs.symlink(real, link);
    await expect(removeDirectoryRecursive(link)).rejects.toThrow(PathEscapeError);
    // The real directory is untouched.
    expect((await fs.stat(real)).isDirectory()).toBe(true);
  });

  it("refuses filesystem roots", async () => {
    await expect(removeDirectoryRecursive("/")).rejects.toThrow(PathEscapeError);
  });
});

describe("createSymlink", () => {
  it("creates and replaces symlinks", async () => {
    const targetA = path.join(tmpDir, "a.txt");
    const targetB = path.join(tmpDir, "b.txt");
    await fs.writeFile(targetA, "a");
    await fs.writeFile(targetB, "b");
    const link = path.join(tmpDir, "link");
    await createSymlink(targetA, link);
    expect(await fs.readlink(link)).toBe(targetA);
    await createSymlink(targetB, link);
    expect(await fs.readlink(link)).toBe(targetB);
  });

  it("refuses to replace a real directory", async () => {
    const dir = path.join(tmpDir, "realdir");
    await fs.mkdir(dir, { recursive: true });
    await expect(createSymlink(path.join(tmpDir, "x"), dir)).rejects.toThrow(/conflict/i);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it("refuses to replace a real file", async () => {
    const file = path.join(tmpDir, "real.txt");
    await fs.writeFile(file, "data");
    await expect(createSymlink(path.join(tmpDir, "x"), file)).rejects.toThrow(/conflict/i);
  });
});

describe("detectSymlinkLoop", () => {
  it("detects loops", async () => {
    const a = path.join(tmpDir, "loop-a");
    const b = path.join(tmpDir, "loop-b");
    await fs.symlink(b, a);
    await fs.symlink(a, b);
    expect(await detectSymlinkLoop(a)).toBe(true);

    const file = path.join(tmpDir, "plain.txt");
    await fs.writeFile(file, "x");
    expect(await detectSymlinkLoop(file)).toBe(false);
  });
});
