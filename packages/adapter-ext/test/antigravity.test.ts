import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { antigravityAdapter } from "../src/antigravity.js";
import {
  globalInstruction,
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  projectInstruction,
  stdioServer,
} from "./helpers.js";

describe("antigravity: detection", () => {
  it("detects the binary and ~/.gemini/config root", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "antigravity", "1.0.5");
    const detection = await antigravityAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "antigravity" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "1.0.5",
      userConfigRoot: path.join(tmp, "home", ".gemini", "config"),
      projectConfigRoot: path.join(tmp, "project", ".agents"),
    });
  });

  it("also detects the legacy .agent project dir", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "project", ".agent"), { recursive: true });
    const detection = await antigravityAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async () => undefined,
    });
    expect(detection.installed).toBe(true);
  });
});

describe("antigravity: MCP server values", () => {
  it("uses serverUrl for remotes and no type for stdio", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await antigravityAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "json-merge");

    const [github, docs] = merges;
    if (github?.kind !== "json-merge" || docs?.kind !== "json-merge") {
      throw new Error("expected json-merge artifacts");
    }
    expect(github.value).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    expect(docs.value).toEqual({
      serverUrl: "https://example.com/mcp",
      headers: { Authorization: "${API_TOKEN}" },
    });
  });

  it("routes merges to mcp_config.json under .agents and ~/.gemini/config", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await antigravityAdapter.planInstall(
      await antigravityAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(tmp, "home", ".gemini", "config", "mcp_config.json"));

    const projectOps = await antigravityAdapter.planInstall(
      await antigravityAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".agents", "mcp_config.json"));
  });
});

describe("antigravity: instructions", () => {
  it("writes .agents/rules/agentpack.md and the global ~/.gemini/GEMINI.md", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, globalInstruction],
    });

    const projectOps = await antigravityAdapter.planInstall(
      await antigravityAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectSection = projectOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "coding-style",
    );
    if (projectSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(projectSection.path).toBe(path.join(tmp, "project", ".agents", "rules", "agentpack.md"));

    const userOps = await antigravityAdapter.planInstall(
      await antigravityAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userSection = userOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "global-style",
    );
    if (userSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    // userFile "../GEMINI.md" escapes the ~/.gemini/config root to ~/.gemini.
    expect(userSection.path).toBe(path.join(tmp, "home", ".gemini", "GEMINI.md"));
  });
});

describe("antigravity: import", () => {
  it("round-trips serverUrl entries", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".gemini", "config");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          cloudrun: { command: "npx", args: ["-y", "@google-cloud/cloud-run-mcp"] },
          remote: {
            serverUrl: "https://connect.composio.dev/mcp",
            headers: { "x-consumer-api-key": "${COMPOSIO_KEY}" },
          },
        },
      }),
    );

    const result = await antigravityAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["cloudrun"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@google-cloud/cloud-run-mcp"],
      enabled: true,
    });
    expect(result.mcpServers["remote"]).toEqual({
      transport: "http",
      url: "https://connect.composio.dev/mcp",
      headers: { "x-consumer-api-key": { fromEnv: "COMPOSIO_KEY" } },
      enabled: true,
    });
  });
});
