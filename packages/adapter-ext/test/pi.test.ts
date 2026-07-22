import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { piAdapter } from "../src/pi.js";
import {
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  stdioServer,
} from "./helpers.js";

describe("pi: detection", () => {
  it("detects the pi binary; PI_CODING_AGENT_DIR relocates the agent dir", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "pi", "0.18.2");
    const agentDir = path.join(tmp, "pi-agent");
    const detection = await piAdapter.detect({
      env: { PI_CODING_AGENT_DIR: agentDir },
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "pi" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "0.18.2",
      userConfigRoot: agentDir,
      projectConfigRoot: path.join(tmp, "project", ".pi"),
    });
  });
});

describe("pi: MCP server values", () => {
  it("uses the standard mcpServers shape with plain ${VAR} refs", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await piAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
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
      url: "https://example.com/mcp",
      headers: { Authorization: "${API_TOKEN}" },
    });
  });

  it("routes merges to the agent dir mcp.json and project .mcp.json", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const agentDir = path.join(tmp, "pi-agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };

    const userOps = await piAdapter.planInstall(
      await piAdapter.generate(pack, makeContext(tmp, { scope: "user", env })),
      makeInstallContext(tmp, { scope: "user", env }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(agentDir, "mcp.json"));

    const projectOps = await piAdapter.planInstall(
      await piAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".mcp.json"));
  });
});

describe("pi: import", () => {
  it("round-trips the extension mcp.json", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".pi", "agent");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
          },
        },
      }),
    );

    const result = await piAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["github"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      enabled: true,
    });
  });
});
