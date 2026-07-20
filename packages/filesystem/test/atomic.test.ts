import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureDir,
  isSymlink,
  pathExists,
  readFileIfExists,
  writeFileAtomic,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-atomic-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("creates the file and missing parents", async () => {
    const file = path.join(tmpDir, "a", "b", "f.txt");
    await writeFileAtomic(file, "hello");
    expect(await fs.readFile(file, "utf8")).toBe("hello");
  });

  it("leaves no temp files behind", async () => {
    const file = path.join(tmpDir, "f.txt");
    await writeFileAtomic(file, "hello");
    const names = await fs.readdir(tmpDir);
    expect(names).toEqual(["f.txt"]);
  });

  it.skipIf(process.platform === "win32")(
    "preserves the existing file mode when no mode is given",
    async () => {
      const file = path.join(tmpDir, "run.sh");
      await fs.writeFile(file, "old");
      await fs.chmod(file, 0o755);
      await writeFileAtomic(file, "new");
      expect((await fs.stat(file)).mode & 0o777).toBe(0o755);
      expect(await fs.readFile(file, "utf8")).toBe("new");
    },
  );

  it.skipIf(process.platform === "win32")("applies an explicit mode", async () => {
    const file = path.join(tmpDir, "run.sh");
    await writeFileAtomic(file, "x", { mode: 0o700 });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o700);
  });
});

describe("ensureDir", () => {
  it("creates nested directories idempotently", async () => {
    const dir = path.join(tmpDir, "x", "y");
    await ensureDir(dir);
    await ensureDir(dir);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });
});

describe("readFileIfExists / pathExists / isSymlink", () => {
  it("reads existing files and returns undefined for missing ones", async () => {
    const file = path.join(tmpDir, "f.txt");
    expect(await readFileIfExists(file)).toBeUndefined();
    await fs.writeFile(file, "data");
    expect(await readFileIfExists(file)).toBe("data");
  });

  it("detects existence and symlinks", async () => {
    const file = path.join(tmpDir, "f.txt");
    const link = path.join(tmpDir, "l.txt");
    await fs.writeFile(file, "data");
    await fs.symlink(file, link);
    expect(await pathExists(file)).toBe(true);
    expect(await pathExists(path.join(tmpDir, "missing"))).toBe(false);
    expect(await isSymlink(link)).toBe(true);
    expect(await isSymlink(file)).toBe(false);
    expect(await isSymlink(path.join(tmpDir, "missing"))).toBe(false);
  });
});
