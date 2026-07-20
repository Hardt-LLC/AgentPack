import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PathEscapeError,
  isPathInside,
  normalizeRelativePath,
  resolveInside,
  toPosixPath,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-paths-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("toPosixPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(toPosixPath("a\\b\\c")).toBe("a/b/c");
    expect(toPosixPath("a/b")).toBe("a/b");
  });
});

describe("normalizeRelativePath", () => {
  it("normalizes simple nested paths", () => {
    expect(normalizeRelativePath("a/b/c.txt")).toBe("a/b/c.txt");
    expect(normalizeRelativePath("a\\b\\c.txt")).toBe("a/b/c.txt");
  });

  it("rejects parent traversal", () => {
    expect(() => normalizeRelativePath("../x")).toThrow(PathEscapeError);
    expect(() => normalizeRelativePath("a/../../b")).toThrow(PathEscapeError);
    expect(() => normalizeRelativePath("..")).toThrow(PathEscapeError);
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow(PathEscapeError);
    expect(() => normalizeRelativePath("C:\\Windows\\x")).toThrow(PathEscapeError);
  });

  it("rejects empty segments", () => {
    expect(() => normalizeRelativePath("a//b")).toThrow(PathEscapeError);
    expect(() => normalizeRelativePath("")).toThrow(PathEscapeError);
  });
});

describe("resolveInside", () => {
  it("resolves legitimate nested paths", async () => {
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    const resolved = resolveInside(tmpDir, "sub/file.txt");
    expect(resolved).toBe(path.join(path.resolve(tmpDir), "sub", "file.txt"));
  });

  it("resolves paths that do not exist yet", () => {
    const resolved = resolveInside(tmpDir, "new/deep/file.txt");
    expect(isPathInside(tmpDir, resolved)).toBe(true);
  });

  it("rejects escapes", () => {
    expect(() => resolveInside(tmpDir, "../outside.txt")).toThrow(PathEscapeError);
    expect(() => resolveInside(tmpDir, "a/../../outside.txt")).toThrow(PathEscapeError);
  });

  it("rejects a symlink ancestor pointing outside the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-outside-"));
    try {
      await fs.symlink(outside, path.join(tmpDir, "link"));
      expect(() => resolveInside(tmpDir, "link/file.txt")).toThrow(PathEscapeError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink ancestor pointing outside through a non-existing tail", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-outside-"));
    try {
      await fs.symlink(outside, path.join(tmpDir, "link"));
      expect(() => resolveInside(tmpDir, "link/not-created-yet/file.txt")).toThrow(PathEscapeError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("allows an internal symlink pointing inside the root", async () => {
    await fs.mkdir(path.join(tmpDir, "real"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "real", "file.txt"), "x");
    await fs.symlink(path.join(tmpDir, "real"), path.join(tmpDir, "link"));
    const resolved = resolveInside(tmpDir, "link/file.txt");
    expect(isPathInside(tmpDir, resolved)).toBe(true);
  });
});

describe("isPathInside", () => {
  it("detects containment", () => {
    expect(isPathInside("/a/b", "/a/b/c")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/c")).toBe(false);
    expect(isPathInside("/a/b", "/a/b/../c")).toBe(false);
  });
});
