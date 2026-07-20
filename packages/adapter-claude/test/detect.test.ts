import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { DetectionContext } from "@agentpack/schema";

import { createClaudeAdapter } from "../src/index.js";
import { makeTmpDir } from "./helpers.js";

async function writeExecutable(dir: string, name: string, script: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, script);
  await fs.chmod(filePath, 0o755);
  return filePath;
}

function makeDetectionContext(
  tmp: string,
  findExecutable?: (name: string) => Promise<string | undefined>,
): DetectionContext {
  return {
    env: {},
    homeDir: path.join(tmp, "home"),
    projectRoot: path.join(tmp, "project"),
    platform: "darwin",
    findExecutable,
  };
}

describe("detect", () => {
  it("reports an installed Claude Code with its version", async () => {
    const tmp = await makeTmpDir();
    const bin = await writeExecutable(tmp, "claude", '#!/bin/sh\necho "1.4.2 (Claude Code)"\n');
    const adapter = createClaudeAdapter();

    const detection = await adapter.detect(makeDetectionContext(tmp, async () => bin));

    expect(detection.installed).toBe(true);
    expect(detection.executablePath).toBe(bin);
    expect(detection.version).toBe("1.4.2");
    expect(detection.userConfigRoot).toBe(path.join(tmp, "home", ".claude"));
    expect(detection.projectConfigRoot).toBe(path.join(tmp, "project", ".claude"));
    expect(detection.warnings).toEqual([]);
  });

  it("reports Claude Code as absent when the executable is not found", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();

    const detection = await adapter.detect(makeDetectionContext(tmp, async () => undefined));

    expect(detection.installed).toBe(false);
    expect(detection.executablePath).toBeUndefined();
    expect(detection.userConfigRoot).toBe(path.join(tmp, "home", ".claude"));
    expect(detection.projectConfigRoot).toBe(path.join(tmp, "project", ".claude"));
    expect(detection.warnings).toEqual([]);
  });

  it("warns instead of failing when the version probe fails", async () => {
    const tmp = await makeTmpDir();
    const bin = await writeExecutable(tmp, "claude", "#!/bin/sh\nexit 1\n");
    const adapter = createClaudeAdapter();

    const detection = await adapter.detect(makeDetectionContext(tmp, async () => bin));

    expect(detection.installed).toBe(true);
    expect(detection.version).toBeUndefined();
    expect(detection.warnings).toHaveLength(1);
    expect(detection.warnings[0]).toContain("failed to determine the Claude Code version");
  });

  it("does not throw when no findExecutable is provided", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();

    const detection = await adapter.detect(makeDetectionContext(tmp));

    expect(detection.installed).toBe(false);
  });
});
