import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { geminiAdapter } from "../src/gemini.js";
import {
  directoryInstruction,
  globalInstruction,
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  projectInstruction,
  sseServer,
  stdioServer,
} from "./helpers.js";

describe("gemini: detection", () => {
  it("detects the gemini binary and ~/.gemini roots", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "gemini", "0.6.1");
    const detection = await geminiAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "gemini" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "0.6.1",
      userConfigRoot: path.join(tmp, "home", ".gemini"),
      projectConfigRoot: path.join(tmp, "project", ".gemini"),
    });
  });
});

describe("gemini: MCP server values", () => {
  it("infers transport from keys: command / httpUrl / url", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer, events: sseServer },
    });
    const artifacts = await geminiAdapter.generate(pack, makeContext(tmp));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/mcpServers/github",
      "/mcpServers/docs",
      "/mcpServers/events",
    ]);

    const [github, docs, events] = merges;
    if (
      github?.kind !== "json-merge" ||
      docs?.kind !== "json-merge" ||
      events?.kind !== "json-merge"
    ) {
      throw new Error("expected json-merge artifacts");
    }
    // stdio: no "type" key, plain ${VAR} env references.
    expect(github.value).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    // HTTP uses httpUrl.
    expect(docs.value).toEqual({
      httpUrl: "https://example.com/mcp",
      headers: { Authorization: "${API_TOKEN}" },
    });
    // SSE uses url.
    expect(events.value).toEqual({ url: "https://example.com/sse" });
  });

  it("merges into settings.json for both scopes", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await geminiAdapter.planInstall(
      await geminiAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(tmp, "home", ".gemini", "settings.json"));

    const projectOps = await geminiAdapter.planInstall(
      await geminiAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".gemini", "settings.json"));
  });
});

describe("gemini: instructions", () => {
  it("writes GEMINI.md for project, directory and user scopes", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, directoryInstruction, globalInstruction],
    });

    const projectOps = await geminiAdapter.planInstall(
      await geminiAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const paths = projectOps
      .filter((o) => o.type === "managedMarkdownSection")
      .map((o) => (o.type === "managedMarkdownSection" ? o.path : ""));
    expect(paths).toEqual([
      path.join(tmp, "project", "GEMINI.md"),
      path.join(tmp, "project", "src", "GEMINI.md"),
      path.join(tmp, "home", ".gemini", "GEMINI.md"),
    ]);
  });
});

describe("gemini: import", () => {
  it("round-trips command/httpUrl/url entries from settings.json", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".gemini");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        mcpServers: {
          pythonTools: {
            command: "python",
            args: ["-m", "my_mcp_server"],
            env: { API_KEY: "${EXTERNAL_API_KEY}" },
            timeout: 15000,
          },
          httpServer: { httpUrl: "https://api.example.com/mcp" },
          sseServer: { url: "https://api.example.com/sse" },
        },
      }),
    );

    const result = await geminiAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["pythonTools"]).toEqual({
      transport: "stdio",
      command: "python",
      args: ["-m", "my_mcp_server"],
      env: { API_KEY: { fromEnv: "EXTERNAL_API_KEY" } },
      enabled: true,
    });
    expect(result.mcpServers["httpServer"]).toEqual({
      transport: "http",
      url: "https://api.example.com/mcp",
      enabled: true,
    });
    expect(result.mcpServers["sseServer"]).toEqual({
      transport: "sse",
      url: "https://api.example.com/sse",
      enabled: true,
    });
  });
});
