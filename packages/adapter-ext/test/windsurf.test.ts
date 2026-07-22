import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  globalInstruction,
  hook,
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  projectInstruction,
  skill,
  stdioServer,
} from "./helpers.js";
import { windsurfAdapter } from "../src/windsurf.js";

describe("windsurf: detection", () => {
  it("uses the current ~/.codeium/windsurf root and <project>/.windsurf", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "windsurf", "1.9.0");
    const detection = await windsurfAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "windsurf" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "1.9.0",
      userConfigRoot: path.join(tmp, "home", ".codeium", "windsurf"),
      projectConfigRoot: path.join(tmp, "project", ".windsurf"),
    });
  });
});

describe("windsurf: MCP server values", () => {
  it("uses serverUrl for remote entries", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await windsurfAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges).toHaveLength(2);

    const github = merges[0];
    if (github?.kind !== "json-merge") throw new Error("expected json-merge");
    expect(github.value).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });

    const docs = merges[1];
    if (docs?.kind !== "json-merge") throw new Error("expected json-merge");
    expect(docs.value).toEqual({
      serverUrl: "https://example.com/mcp",
      headers: { Authorization: "${env:API_TOKEN}" },
    });
  });

  it("merges into ~/.codeium/windsurf/mcp_config.json at user scope", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const ops = await windsurfAdapter.planInstall(
      await windsurfAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const merge = ops.find((o) => o.type === "mergeJson");
    if (merge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(merge.path).toBe(path.join(tmp, "home", ".codeium", "windsurf", "mcp_config.json"));
  });

  it("degrades project-scope MCP (no project MCP file is documented)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const report = await windsurfAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "mcp",
        componentId: "github",
        support: "degraded",
      }),
    ]);
    const artifacts = await windsurfAdapter.generate(pack, makeContext(tmp));
    expect(artifacts.filter((a) => a.kind === "json-merge")).toEqual([]);
  });
});

describe("windsurf: skills, instructions, hooks", () => {
  it("resolves skill dirs for both scopes", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });

    const projectOps = await windsurfAdapter.planInstall(
      await windsurfAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp, { installMode: "copy" }),
    );
    const projectCopy = projectOps.find((o) => o.type === "copyDirectory");
    if (projectCopy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
    expect(projectCopy.dest).toBe(path.join(tmp, "project", ".windsurf", "skills", "review"));

    const userOps = await windsurfAdapter.planInstall(
      await windsurfAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user", installMode: "copy" }),
    );
    const userCopy = userOps.find((o) => o.type === "copyDirectory");
    if (userCopy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
    expect(userCopy.dest).toBe(path.join(tmp, "home", ".codeium", "windsurf", "skills", "review"));
  });

  it("writes .windsurfrules at the project root and global_rules.md at user scope", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, globalInstruction],
    });

    const projectOps = await windsurfAdapter.planInstall(
      await windsurfAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectSection = projectOps.find((o) => o.type === "managedMarkdownSection");
    if (projectSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(projectSection.path).toBe(path.join(tmp, "project", ".windsurfrules"));

    const userOps = await windsurfAdapter.planInstall(
      await windsurfAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userSection = userOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "global-style",
    );
    if (userSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(userSection.path).toBe(
      path.join(tmp, "home", ".codeium", "windsurf", "memories", "global_rules.md"),
    );
  });

  it("classifies hooks as transpiled and writes <configRoot>/hooks.json", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { hooks: [hook] });
    const report = await windsurfAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({ componentType: "hook", support: "transpiled" }),
    ]);

    const ops = await windsurfAdapter.planInstall(
      await windsurfAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const hooksOp = ops.find((o) => o.type === "mergeJson");
    if (hooksOp?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(hooksOp.path).toBe(path.join(tmp, "home", ".codeium", "windsurf", "hooks.json"));
    expect(hooksOp.pointer).toBe("/hooks/preToolUse");
  });
});

describe("windsurf: import", () => {
  it("round-trips serverUrl entries", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".codeium", "windsurf");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            serverUrl: "https://example.com/mcp",
            headers: { Authorization: "${env:API_TOKEN}" },
          },
        },
      }),
    );

    const result = await windsurfAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["docs"]).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: { fromEnv: "API_TOKEN" } },
      enabled: true,
    });
  });
});
