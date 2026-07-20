import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pathExists, withProcessLock } from "../src/index.js";

let tmpDir: string;
let lockPath: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-lock-")));
  lockPath = path.join(tmpDir, "agentpack.lock");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("withProcessLock", () => {
  it("runs the function and releases the lock", async () => {
    const result = await withProcessLock(lockPath, async () => 42);
    expect(result).toBe(42);
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("fails while the lock is held by a live process", async () => {
    await withProcessLock(lockPath, async () => {
      await expect(withProcessLock(lockPath, async () => "inner")).rejects.toThrow(
        "another agentpack process is running",
      );
    });
  });

  it("reclaims a stale lock from a dead process", async () => {
    // A pid that is (practically) guaranteed not to exist.
    await fs.writeFile(lockPath, "4194303");
    const result = await withProcessLock(lockPath, async () => "reclaimed");
    expect(result).toBe("reclaimed");
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("releases the lock even when the function throws", async () => {
    await expect(
      withProcessLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await pathExists(lockPath)).toBe(false);
  });
});
