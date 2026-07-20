import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashDirectory, hashFile, sha256 } from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-hash-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("sha256", () => {
  it("returns a deterministic sha256:<hex> digest", () => {
    const hash = sha256("hello");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).toBe(sha256("hello"));
    expect(hash).toBe(sha256(Buffer.from("hello")));
  });

  it("changes with content", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("hashFile", () => {
  it("matches sha256 of the file content", async () => {
    const file = path.join(tmpDir, "f.txt");
    await fs.writeFile(file, "content");
    expect(await hashFile(file)).toBe(sha256("content"));
  });
});

describe("hashDirectory", () => {
  it("is deterministic and order-independent", async () => {
    const a = path.join(tmpDir, "a");
    const b = path.join(tmpDir, "b");
    await fs.mkdir(path.join(a, "sub"), { recursive: true });
    await fs.mkdir(path.join(b, "sub"), { recursive: true });
    // Create the same tree in different orders.
    await fs.writeFile(path.join(a, "x.txt"), "x");
    await fs.writeFile(path.join(a, "sub", "y.txt"), "y");
    await fs.writeFile(path.join(b, "sub", "y.txt"), "y");
    await fs.writeFile(path.join(b, "x.txt"), "x");
    expect(await hashDirectory(a)).toBe(await hashDirectory(b));
  });

  it("changes when content changes", async () => {
    const dir = path.join(tmpDir, "d");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "f.txt"), "one");
    const before = await hashDirectory(dir);
    await fs.writeFile(path.join(dir, "f.txt"), "two");
    expect(await hashDirectory(dir)).not.toBe(before);
  });

  it("changes when file names change", async () => {
    const a = path.join(tmpDir, "a");
    const b = path.join(tmpDir, "b");
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    await fs.writeFile(path.join(a, "x.txt"), "same");
    await fs.writeFile(path.join(b, "y.txt"), "same");
    expect(await hashDirectory(a)).not.toBe(await hashDirectory(b));
  });

  it("hashes the symlink path string, not the target content", async () => {
    const target = path.join(tmpDir, "target.txt");
    await fs.writeFile(target, "target-content");
    const withLink = path.join(tmpDir, "with-link");
    await fs.mkdir(withLink, { recursive: true });
    await fs.symlink(target, path.join(withLink, "link"));
    const hash = await hashDirectory(withLink);
    // Replacing the symlink with a copy of the target content changes the hash.
    await fs.rm(path.join(withLink, "link"));
    await fs.writeFile(path.join(withLink, "link"), "target-content");
    expect(await hashDirectory(withLink)).not.toBe(hash);
  });
});
