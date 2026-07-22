import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copilotCliAdapter } from "../src/copilot-cli.js";
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
  skill,
  stdioServer,
} from "./helpers.js";

describe("copilot-cli: detection", () => {
  it("detects the copilot binary and honors COPILOT_HOME", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "copilot", "0.0.328");
    const customHome = path.join(tmp, "copilot-home");
    const detection = await copilotCliAdapter.detect({
      env: { COPILOT_HOME: customHome },
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "copilot" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "0.0.328",
      userConfigRoot: customHome,
    });
  });
});

describe("copilot-cli: MCP server values", () => {
  it("emits explicit stdio/http types under mcpServers", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await copilotCliAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/mcpServers/github",
      "/mcpServers/docs",
    ]);

    const [github, docs] = merges;
    if (github?.kind !== "json-merge" || docs?.kind !== "json-merge") {
      throw new Error("expected json-merge artifacts");
    }
    expect(github.value).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    expect(docs.value).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "${env:API_TOKEN}" },
    });
  });

  it("routes user merges to mcp-config.json (COPILOT_HOME-aware) and project to .mcp.json", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const defaultOps = await copilotCliAdapter.planInstall(
      await copilotCliAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const defaultMerge = defaultOps.find((o) => o.type === "mergeJson");
    if (defaultMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(defaultMerge.path).toBe(path.join(tmp, "home", ".copilot", "mcp-config.json"));

    const customHome = path.join(tmp, "copilot-home");
    const env = { COPILOT_HOME: customHome };
    const envOps = await copilotCliAdapter.planInstall(
      await copilotCliAdapter.generate(pack, makeContext(tmp, { scope: "user", env })),
      makeInstallContext(tmp, { scope: "user", env }),
    );
    const envMerge = envOps.find((o) => o.type === "mergeJson");
    if (envMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(envMerge.path).toBe(path.join(customHome, "mcp-config.json"));

    const projectOps = await copilotCliAdapter.planInstall(
      await copilotCliAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".mcp.json"));
  });
});

describe("copilot-cli: skills and instructions", () => {
  it("honors COPILOT_HOME for the user skills dir", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });
    const customHome = path.join(tmp, "copilot-home");
    const env = { COPILOT_HOME: customHome };
    const ops = await copilotCliAdapter.planInstall(
      await copilotCliAdapter.generate(pack, makeContext(tmp, { scope: "user", env })),
      makeInstallContext(tmp, { scope: "user", env, installMode: "copy" }),
    );
    const copy = ops.find((o) => o.type === "copyDirectory");
    if (copy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
    expect(copy.dest).toBe(path.join(customHome, "skills", "review"));
  });

  it("writes project and user copilot-instructions.md files", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, globalInstruction],
    });

    const projectOps = await copilotCliAdapter.planInstall(
      await copilotCliAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectSection = projectOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "coding-style",
    );
    if (projectSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(projectSection.path).toBe(
      path.join(tmp, "project", ".github", "copilot-instructions.md"),
    );

    const userOps = await copilotCliAdapter.planInstall(
      await copilotCliAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userSection = userOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "global-style",
    );
    if (userSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(userSection.path).toBe(path.join(tmp, "home", ".copilot", "copilot-instructions.md"));
  });
});

describe("copilot-cli: import", () => {
  it("round-trips local and http entries", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".copilot");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          playwright: {
            type: "local",
            command: "npx",
            args: ["@playwright/mcp@latest"],
            tools: ["*"],
          },
          context7: {
            type: "http",
            url: "https://mcp.context7.com/mcp",
            headers: { CONTEXT7_API_KEY: "${env:CONTEXT7_API_KEY}" },
          },
        },
      }),
    );

    const result = await copilotCliAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["playwright"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp@latest"],
      enabled: true,
    });
    expect(result.mcpServers["context7"]).toEqual({
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { CONTEXT7_API_KEY: { fromEnv: "CONTEXT7_API_KEY" } },
      enabled: true,
    });
  });
});
