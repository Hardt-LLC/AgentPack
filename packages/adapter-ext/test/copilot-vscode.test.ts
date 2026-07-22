import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copilotVscodeAdapter } from "../src/copilot-vscode.js";
import { vscodeUserDir } from "../src/factory.js";
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

function userDir(tmp: string): string {
  return vscodeUserDir({ env: {}, homeDir: path.join(tmp, "home"), platform: process.platform });
}

describe("copilot-vscode: detection", () => {
  it("detects via the code executable and reports the VS Code User dir", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "code", "1.96.0");
    const detection = await copilotVscodeAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "code" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "1.96.0",
      userConfigRoot: userDir(tmp),
      projectConfigRoot: path.join(tmp, "project", ".vscode"),
    });
  });
});

describe("copilot-vscode: MCP server values", () => {
  it("uses the servers top key with explicit stdio/http types", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await copilotVscodeAdapter.generate(pack, makeContext(tmp));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/servers/github",
      "/servers/docs",
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

  it("routes merges to the profile mcp.json and .vscode/mcp.json", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await copilotVscodeAdapter.planInstall(
      await copilotVscodeAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(userDir(tmp), "mcp.json"));

    const projectOps = await copilotVscodeAdapter.planInstall(
      await copilotVscodeAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".vscode", "mcp.json"));
  });
});

describe("copilot-vscode: skills, instructions, hooks", () => {
  it("installs skills into .github/skills and ~/.copilot/skills", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });

    const projectOps = await copilotVscodeAdapter.planInstall(
      await copilotVscodeAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp, { installMode: "copy" }),
    );
    const projectCopy = projectOps.find((o) => o.type === "copyDirectory");
    if (projectCopy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
    expect(projectCopy.dest).toBe(path.join(tmp, "project", ".github", "skills", "review"));

    const userOps = await copilotVscodeAdapter.planInstall(
      await copilotVscodeAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user", installMode: "copy" }),
    );
    const userCopy = userOps.find((o) => o.type === "copyDirectory");
    if (userCopy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
    expect(userCopy.dest).toBe(path.join(tmp, "home", ".copilot", "skills", "review"));
  });

  it("writes .github/copilot-instructions.md; user instructions unsupported", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, globalInstruction],
    });

    const projectOps = await copilotVscodeAdapter.planInstall(
      await copilotVscodeAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const section = projectOps.find((o) => o.type === "managedMarkdownSection");
    if (section?.type !== "managedMarkdownSection") throw new Error("expected markdown section");
    expect(section.path).toBe(path.join(tmp, "project", ".github", "copilot-instructions.md"));

    const report = await copilotVscodeAdapter.analyze(pack, makeContext(tmp, { scope: "user" }));
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        componentType: "instruction",
        componentId: "global-style",
        support: "unsupported",
      }),
    );
  });

  it("classifies hooks as unsupported for MVP", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { hooks: [hook] });
    const report = await copilotVscodeAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "hook",
        support: "unsupported",
        remediation: "target has no AgentPack-managed hook format yet",
      }),
    ]);
  });
});

describe("copilot-vscode: import", () => {
  it("round-trips the servers envelope", async () => {
    const tmp = await makeTmpDir();
    const dir = userDir(tmp);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        servers: {
          github: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" },
          },
          docs: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    );

    const result = await copilotVscodeAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["github"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      enabled: true,
    });
    expect(result.mcpServers["docs"]).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    });
  });
});
