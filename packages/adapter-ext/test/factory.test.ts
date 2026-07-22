import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cursorAdapter } from "../src/cursor.js";
import {
  hook,
  httpServer,
  makeContext,
  makeExecutable,
  makeInstallContext,
  makePack,
  makeTmpDir,
  projectInstruction,
  skill,
  stdioServer,
} from "./helpers.js";

describe("factory: planInstall skill install modes", () => {
  it("symlinks in symlink mode and in auto mode with reliable symlinks", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });
    const artifacts = await cursorAdapter.generate(pack, makeContext(tmp));

    for (const context of [
      makeInstallContext(tmp, { installMode: "symlink", symlinksReliable: false }),
      makeInstallContext(tmp, { installMode: "auto", symlinksReliable: true }),
    ]) {
      const ops = await cursorAdapter.planInstall(artifacts, context);
      const link = ops.find((o) => o.type === "createSymlink");
      if (link?.type !== "createSymlink") throw new Error("expected createSymlink");
      expect(link.path).toBe(path.join(tmp, "project", ".cursor", "skills", "review"));
      expect(link.target).toBe("/packs/test/skills/review");
      expect(ops.some((o) => o.type === "copyDirectory")).toBe(false);
    }
  });

  it("copies in copy mode and in auto mode without reliable symlinks", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });
    const artifacts = await cursorAdapter.generate(pack, makeContext(tmp));

    for (const context of [
      makeInstallContext(tmp, { installMode: "copy" }),
      makeInstallContext(tmp, { installMode: "auto", symlinksReliable: false }),
    ]) {
      const ops = await cursorAdapter.planInstall(artifacts, context);
      const copy = ops.find((o) => o.type === "copyDirectory");
      if (copy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
      expect(copy.source).toBe("/packs/test/skills/review");
      expect(copy.dest).toBe(path.join(tmp, "project", ".cursor", "skills", "review"));
      expect(ops.some((o) => o.type === "createSymlink")).toBe(false);
    }
  });
});

describe("factory: planInstall path resolution", () => {
  it("routes MCP merges to the scope's native file and hooks to <configRoot>/hooks.json", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer },
      hooks: [hook],
    });

    const projectOps = await cursorAdapter.planInstall(
      await cursorAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMcp = projectOps.find((o) => o.type === "mergeJson");
    if (projectMcp?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMcp.path).toBe(path.join(tmp, "project", ".cursor", "mcp.json"));
    expect(projectMcp.pointer).toBe("/mcpServers/github");
    const projectHooks = projectOps.filter((o) => o.type === "mergeJson")[1];
    if (projectHooks?.type !== "mergeJson") throw new Error("expected hooks mergeJson");
    expect(projectHooks.path).toBe(path.join(tmp, "project", ".cursor", "hooks.json"));
    expect(projectHooks.pointer).toBe("/hooks/preToolUse");

    const userOps = await cursorAdapter.planInstall(
      await cursorAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMcp = userOps.find((o) => o.type === "mergeJson");
    if (userMcp?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMcp.path).toBe(path.join(tmp, "home", ".cursor", "mcp.json"));
  });

  it("routes project markdown sections to the project root, not the config root", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { instructions: [projectInstruction] });
    const ops = await cursorAdapter.planInstall(
      await cursorAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const section = ops.find((o) => o.type === "managedMarkdownSection");
    if (section?.type !== "managedMarkdownSection") throw new Error("expected markdown section");
    expect(section.path).toBe(path.join(tmp, "project", "AGENTS.md"));
    expect(section.sectionId).toBe("coding-style");
  });
});

describe("factory: MCP value shapes via generate", () => {
  it("renders env fromEnv references in the target's native syntax", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await cursorAdapter.generate(pack, makeContext(tmp));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges).toHaveLength(2);
    const github = merges[0];
    if (github?.kind !== "json-merge") throw new Error("expected json-merge");
    expect(github.value).toMatchObject({
      env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
  });
});

describe("cursor detection edge cases", () => {
  it("probes the `agent` executable when `cursor` is absent", async () => {
    const tmp = await makeTmpDir();
    const agentPath = await makeExecutable(path.join(tmp, "bin"), "agent", "2.0.1");
    const detection = await cursorAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "agent" ? agentPath : undefined),
    });
    expect(detection.installed).toBe(true);
    expect(detection.executablePath).toBe(agentPath);
    expect(detection.version).toBe("2.0.1");
  });

  it("is not installed when nothing exists", async () => {
    const tmp = await makeTmpDir();
    const detection = await cursorAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async () => undefined,
    });
    expect(detection.installed).toBe(false);
    expect(detection.warnings).toEqual([]);
  });

  it("is installed when only the user config root exists", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "home", ".cursor"), { recursive: true });
    const detection = await cursorAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async () => undefined,
    });
    expect(detection.installed).toBe(true);
  });
});
