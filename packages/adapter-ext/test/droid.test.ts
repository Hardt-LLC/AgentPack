import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { droidAdapter } from "../src/droid.js";
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

describe("droid: detection", () => {
  it("detects the droid binary and ~/.factory roots", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "droid", "0.22.0");
    const detection = await droidAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "droid" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "0.22.0",
      userConfigRoot: path.join(tmp, "home", ".factory"),
      projectConfigRoot: path.join(tmp, "project", ".factory"),
    });
  });
});

describe("droid: MCP server values", () => {
  it("emits explicit stdio/http types with ${VAR} refs", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await droidAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
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
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    expect(docs.value).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "${API_TOKEN}" },
    });
  });

  it("routes merges to ~/.factory/mcp.json and .factory/mcp.json", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await droidAdapter.planInstall(
      await droidAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(tmp, "home", ".factory", "mcp.json"));

    const projectOps = await droidAdapter.planInstall(
      await droidAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".factory", "mcp.json"));
  });
});

describe("droid: skills, instructions, hooks", () => {
  it("installs skills under .factory/skills and ~/.factory/skills", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });

    const projectOps = await droidAdapter.planInstall(
      await droidAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp, { installMode: "copy" }),
    );
    const copy = projectOps.find((o) => o.type === "copyDirectory");
    if (copy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
    expect(copy.dest).toBe(path.join(tmp, "project", ".factory", "skills", "review"));
  });

  it("writes project AGENTS.md; user instructions unsupported", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, globalInstruction],
    });

    const projectOps = await droidAdapter.planInstall(
      await droidAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const section = projectOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "coding-style",
    );
    if (section?.type !== "managedMarkdownSection") throw new Error("expected markdown section");
    expect(section.path).toBe(path.join(tmp, "project", "AGENTS.md"));

    const report = await droidAdapter.analyze(pack, makeContext(tmp, { scope: "user" }));
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        componentType: "instruction",
        componentId: "global-style",
        support: "unsupported",
      }),
    );
  });

  it("classifies hooks as unsupported (nested Claude-Code shape does not fit)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { hooks: [hook] });
    const report = await droidAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "hook",
        support: "unsupported",
        remediation: "target has no AgentPack-managed hook format yet",
      }),
    ]);
  });
});

describe("droid: import", () => {
  it("round-trips mcp.json entries", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".factory");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          playwright: {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest"],
            env: { KEY: "${MY_KEY}" },
          },
          linear: { type: "http", url: "https://mcp.linear.app/mcp", disabled: true },
        },
      }),
    );

    const result = await droidAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["playwright"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: { KEY: { fromEnv: "MY_KEY" } },
      enabled: true,
    });
    expect(result.mcpServers["linear"]).toEqual({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      enabled: false,
    });
  });
});
