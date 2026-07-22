import path from "node:path";

import { describe, expect, it } from "vitest";

import { opencodeAdapter } from "../src/opencode.js";
import {
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
import { promises as fs } from "node:fs";

describe("opencode: detection", () => {
  it("detects the opencode binary and config roots", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "opencode", "0.9.3");
    const detection = await opencodeAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "opencode" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "0.9.3",
      userConfigRoot: path.join(tmp, "home", ".config", "opencode"),
      projectConfigRoot: path.join(tmp, "project", ".opencode"),
    });
  });
});

describe("opencode: MCP server values", () => {
  it("uses local/remote types with command arrays and environment", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await opencodeAdapter.generate(pack, makeContext(tmp));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/mcp/github",
      "/mcp/docs",
    ]);

    const [github, docs] = merges;
    if (github?.kind !== "json-merge" || docs?.kind !== "json-merge") {
      throw new Error("expected json-merge artifacts");
    }
    expect(github.value).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_TOKEN: "{env:GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    expect(docs.value).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "{env:API_TOKEN}" },
    });
  });

  it("routes merges to opencode.json for both scopes", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await opencodeAdapter.planInstall(
      await opencodeAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(tmp, "home", ".config", "opencode", "opencode.json"));

    const projectOps = await opencodeAdapter.planInstall(
      await opencodeAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", "opencode.json"));
  });
});

describe("opencode: skills and hooks", () => {
  it("classifies skills as unsupported (no skills concept)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });
    const report = await opencodeAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "skill",
        support: "unsupported",
        remediation: "OpenCode has no skills directory (use agents/commands/plugins instead)",
      }),
    ]);
  });

  it("classifies hooks as unsupported (plugins only)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { hooks: [hook] });
    const report = await opencodeAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({ componentType: "hook", support: "unsupported" }),
    ]);
  });

  it("writes AGENTS.md at the project root", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { instructions: [projectInstruction] });
    const ops = await opencodeAdapter.planInstall(
      await opencodeAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const section = ops.find((o) => o.type === "managedMarkdownSection");
    if (section?.type !== "managedMarkdownSection") throw new Error("expected markdown section");
    expect(section.path).toBe(path.join(tmp, "project", "AGENTS.md"));
  });
});

describe("opencode: import", () => {
  it("round-trips local/remote entries", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".config", "opencode");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        mcp: {
          "my-local": {
            type: "local",
            command: ["npx", "-y", "my-mcp-command"],
            environment: { MY_ENV_VAR: "{env:MY_ENV_VAR}" },
            enabled: true,
          },
          "my-remote": { type: "remote", url: "https://my-mcp-server.com/mcp" },
        },
      }),
    );

    const result = await opencodeAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["my-local"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "my-mcp-command"],
      env: { MY_ENV_VAR: { fromEnv: "MY_ENV_VAR" } },
      enabled: true,
    });
    expect(result.mcpServers["my-remote"]).toEqual({
      transport: "http",
      url: "https://my-mcp-server.com/mcp",
      enabled: true,
    });
  });
});
