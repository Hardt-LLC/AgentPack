import { promises as fs } from "node:fs";
import path from "node:path";

import type { DetectionContext } from "@agentpack/schema";
import { describe, expect, it } from "vitest";

import { detectKimi } from "../src/detect.js";
import { makeTmpDir } from "./helpers.js";

function detectionContext(
  tmp: string,
  overrides: Partial<DetectionContext> = {},
): DetectionContext {
  return {
    env: {},
    homeDir: path.join(tmp, "home"),
    projectRoot: path.join(tmp, "project"),
    platform: "darwin",
    ...overrides,
  };
}

async function writeFakeKimi(dir: string, script: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "kimi");
  await fs.writeFile(file, script, { mode: 0o755 });
  return file;
}

describe("detectKimi", () => {
  it("finds the executable and probes its version", async () => {
    const tmp = await makeTmpDir();
    const bin = await writeFakeKimi(
      path.join(tmp, "bin"),
      '#!/bin/sh\necho "kimi version 1.2.3"\n',
    );

    const result = await detectKimi(
      detectionContext(tmp, {
        findExecutable: async (name) => (name === "kimi" ? bin : undefined),
      }),
    );

    expect(result.installed).toBe(true);
    expect(result.executablePath).toBe(bin);
    expect(result.version).toBe("1.2.3");
    expect(result.warnings).toEqual([]);
  });

  it("reports not installed when nothing is present", async () => {
    const tmp = await makeTmpDir();
    const result = await detectKimi(
      detectionContext(tmp, { findExecutable: async () => undefined }),
    );

    expect(result.installed).toBe(false);
    expect(result.executablePath).toBeUndefined();
    expect(result.version).toBeUndefined();
  });

  it("honors KIMI_CODE_HOME for the user config root", async () => {
    const tmp = await makeTmpDir();
    const custom = path.join(tmp, "custom-kimi-home");
    const result = await detectKimi(
      detectionContext(tmp, {
        env: { KIMI_CODE_HOME: custom },
        findExecutable: async () => undefined,
      }),
    );

    expect(result.userConfigRoot).toBe(custom);
    expect(result.installed).toBe(false);
  });

  it("defaults the user config root to <homeDir>/.kimi-code", async () => {
    const tmp = await makeTmpDir();
    const result = await detectKimi(
      detectionContext(tmp, { findExecutable: async () => undefined }),
    );

    expect(result.userConfigRoot).toBe(path.join(tmp, "home", ".kimi-code"));
    expect(result.projectConfigRoot).toBe(path.join(tmp, "project", ".kimi-code"));
  });

  it("treats existing config directories as installed", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "project", ".kimi-code"), { recursive: true });

    const result = await detectKimi(
      detectionContext(tmp, { findExecutable: async () => undefined }),
    );

    expect(result.installed).toBe(true);
    expect(result.executablePath).toBeUndefined();
  });

  it("warns when the version probe fails but stays installed", async () => {
    const tmp = await makeTmpDir();
    const missing = path.join(tmp, "bin", "kimi");

    const result = await detectKimi(detectionContext(tmp, { findExecutable: async () => missing }));

    expect(result.installed).toBe(true);
    expect(result.executablePath).toBe(missing);
    expect(result.version).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("--version");
  });
});
