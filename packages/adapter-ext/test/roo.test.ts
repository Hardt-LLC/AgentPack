import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { vscodeGlobalStorage } from "../src/factory.js";
import { rooAdapter } from "../src/roo.js";
import {
  globalInstruction,
  httpServer,
  makeContext,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  projectInstruction,
  skill,
  stdioServer,
} from "./helpers.js";

function globalStorageDir(tmp: string): string {
  return vscodeGlobalStorage(
    { env: {}, homeDir: path.join(tmp, "home"), platform: process.platform },
    "rooveterinaryinc.roo-cline",
  );
}

describe("roo: detection", () => {
  it("has no executables; installs via the extension globalStorage dir", async () => {
    const tmp = await makeTmpDir();
    const absent = await rooAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async () => undefined,
    });
    expect(absent.installed).toBe(false);
    expect(absent.executablePath).toBeUndefined();

    await fs.mkdir(globalStorageDir(tmp), { recursive: true });
    const present = await rooAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async () => undefined,
    });
    expect(present.installed).toBe(true);
    expect(present.userConfigRoot).toBe(path.join(tmp, "home", ".roo"));
    expect(present.projectConfigRoot).toBe(path.join(tmp, "project", ".roo"));
  });
});

describe("roo: skills are unsupported", () => {
  it("classifies skills as unsupported and emits no skill artifacts", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });
    const report = await rooAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "skill",
        componentId: "review",
        support: "unsupported",
        remediation: "Roo Code has no skills directory",
      }),
    ]);
    const artifacts = await rooAdapter.generate(pack, makeContext(tmp));
    expect(artifacts).toEqual([]);
  });
});

describe("roo: MCP server values", () => {
  it("requires explicit types (stdio / streamable-http)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await rooAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "json-merge");

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
      type: "streamable-http",
      url: "https://example.com/mcp",
      headers: { Authorization: "${env:API_TOKEN}" },
    });
  });

  it("routes user merges to globalStorage and project merges to .roo/mcp.json", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await rooAdapter.planInstall(
      await rooAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(globalStorageDir(tmp), "settings", "mcp_settings.json"));

    const projectOps = await rooAdapter.planInstall(
      await rooAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".roo", "mcp.json"));
  });
});

describe("roo: instructions", () => {
  it("writes .roorules and a managed file inside ~/.roo/rules", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, globalInstruction],
    });

    const projectOps = await rooAdapter.planInstall(
      await rooAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectSection = projectOps.find((o) => o.type === "managedMarkdownSection");
    if (projectSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(projectSection.path).toBe(path.join(tmp, "project", ".roorules"));

    const userOps = await rooAdapter.planInstall(
      await rooAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userSection = userOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "global-style",
    );
    if (userSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(userSection.path).toBe(path.join(tmp, "home", ".roo", "rules", "agentpack.md"));
  });
});

describe("roo: import", () => {
  it("round-trips mcp_settings.json and skips typeless URL entries", async () => {
    const tmp = await makeTmpDir();
    const settingsDir = path.join(globalStorageDir(tmp), "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(settingsDir, "mcp_settings.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" },
            alwaysAllow: ["get_issue"],
          },
          broken: { url: "https://example.com/mcp" },
        },
      }),
    );

    const result = await rooAdapter.import!(makeImportContext(tmp));
    expect(result.mcpServers["github"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      enabled: true,
    });
    // Roo errors on URL entries without an explicit type → skipped on import.
    expect(result.mcpServers["broken"]).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('"broken"'))).toBe(true);
  });

  it("watches mcp_settings.json and ~/.roo/rules as native sources", async () => {
    const tmp = await makeTmpDir();
    const sources = await rooAdapter.nativeSources!(makeImportContext(tmp));
    expect(sources).toEqual([
      path.join(globalStorageDir(tmp), "settings", "mcp_settings.json"),
      path.join(tmp, "home", ".roo", "rules"),
    ]);
  });
});
