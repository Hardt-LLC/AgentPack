import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexAdapter } from "../src/index.js";
import { HOME_DIR, makeDetectionContext, PROJECT_ROOT } from "./helpers.js";

describe("detect", () => {
  const adapter = createCodexAdapter();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-codex-detect-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function fakeCodex(script: string): Promise<string> {
    const executable = path.join(tmpDir, "codex");
    await fs.writeFile(executable, script, { mode: 0o755 });
    return executable;
  }

  it("reports installed with version when codex is on PATH", async () => {
    const executable = await fakeCodex('#!/bin/sh\necho "codex 1.2.3"\n');
    const detection = await adapter.detect(
      makeDetectionContext({ findExecutable: async () => executable }),
    );
    expect(detection.installed).toBe(true);
    expect(detection.executablePath).toBe(executable);
    expect(detection.version).toBe("1.2.3");
    expect(detection.warnings).toEqual([]);
  });

  it("reports absent when the executable cannot be found", async () => {
    const detection = await adapter.detect(
      makeDetectionContext({ findExecutable: async () => undefined }),
    );
    expect(detection.installed).toBe(false);
    expect(detection.executablePath).toBeUndefined();
  });

  it("reports absent when findExecutable is not provided", async () => {
    const detection = await adapter.detect(makeDetectionContext());
    expect(detection.installed).toBe(false);
  });

  it("derives config roots from homeDir and projectRoot by default", async () => {
    const detection = await adapter.detect(makeDetectionContext());
    expect(detection.userConfigRoot).toBe(path.join(HOME_DIR, ".codex"));
    expect(detection.projectConfigRoot).toBe(path.join(PROJECT_ROOT, ".codex"));
  });

  it("honors CODEX_HOME for the user config root", async () => {
    const detection = await adapter.detect(
      makeDetectionContext({ env: { CODEX_HOME: "/custom/codex-home" } }),
    );
    expect(detection.userConfigRoot).toBe("/custom/codex-home");
  });

  it("warns but stays installed when the version probe fails", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const detection = await adapter.detect(
      makeDetectionContext({ findExecutable: async () => missing }),
    );
    expect(detection.installed).toBe(true);
    expect(detection.version).toBeUndefined();
    expect(detection.warnings).toHaveLength(1);
    expect(detection.warnings[0]).toContain("codex --version");
  });
});
