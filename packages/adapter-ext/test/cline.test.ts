import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { clineAdapter } from "../src/cline.js";
import {
  hook,
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  sseServer,
  stdioServer,
} from "./helpers.js";

describe("cline: detection", () => {
  it("detects the cline CLI and ~/.cline root", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "cline", "3.1.2");
    const detection = await clineAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "cline" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "3.1.2",
      userConfigRoot: path.join(tmp, "home", ".cline"),
      projectConfigRoot: path.join(tmp, "project", ".cline"),
    });
  });
});

describe("cline: MCP server values", () => {
  it("uses streamableHttp/sse types and no type for stdio", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer, events: sseServer },
    });
    const artifacts = await clineAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges).toHaveLength(3);

    const [github, docs, events] = merges;
    if (
      github?.kind !== "json-merge" ||
      docs?.kind !== "json-merge" ||
      events?.kind !== "json-merge"
    ) {
      throw new Error("expected json-merge artifacts");
    }
    expect(github.value).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    expect(docs.value).toEqual({
      type: "streamableHttp",
      url: "https://example.com/mcp",
      headers: { Authorization: "${env:API_TOKEN}" },
    });
    expect(events.value).toEqual({
      type: "sse",
      url: "https://example.com/sse",
    });
  });

  it("writes data/settings/cline_mcp_settings.json and honors CLINE_DATA_DIR", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const defaultOps = await clineAdapter.planInstall(
      await clineAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const defaultMerge = defaultOps.find((o) => o.type === "mergeJson");
    if (defaultMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(defaultMerge.path).toBe(
      path.join(tmp, "home", ".cline", "data", "settings", "cline_mcp_settings.json"),
    );

    const dataDir = path.join(tmp, "custom-cline-data");
    const env = { CLINE_DATA_DIR: dataDir };
    const overrideOps = await clineAdapter.planInstall(
      await clineAdapter.generate(pack, makeContext(tmp, { scope: "user", env })),
      makeInstallContext(tmp, { scope: "user", env }),
    );
    const overrideMerge = overrideOps.find((o) => o.type === "mergeJson");
    if (overrideMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(overrideMerge.path).toBe(path.join(dataDir, "settings", "cline_mcp_settings.json"));
  });

  it("degrades project-scope MCP (none documented)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const report = await clineAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({ componentType: "mcp", support: "degraded" }),
    ]);
  });
});

describe("cline: hooks and instructions", () => {
  it("classifies hooks as unsupported for MVP", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { hooks: [hook] });
    const report = await clineAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "hook",
        componentId: "lint",
        support: "unsupported",
        remediation: "target has no AgentPack-managed hook format yet",
      }),
    ]);
    const artifacts = await clineAdapter.generate(pack, makeContext(tmp));
    expect(artifacts.filter((a) => a.kind === "json-merge")).toEqual([]);
  });

  it("writes .clinerules and rules/default.md", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [
        {
          id: "style",
          sourcePath: "/packs/test/style.md",
          content: "Style.",
          scope: "project",
          priority: 100,
          mergeStrategy: "managed-section",
        },
        {
          id: "global",
          sourcePath: "/packs/test/global.md",
          content: "Global.",
          scope: "global",
          priority: 100,
          mergeStrategy: "managed-section",
        },
      ],
    });

    const projectOps = await clineAdapter.planInstall(
      await clineAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectSection = projectOps.find((o) => o.type === "managedMarkdownSection");
    if (projectSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(projectSection.path).toBe(path.join(tmp, "project", ".clinerules"));

    const userOps = await clineAdapter.planInstall(
      await clineAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userSection = userOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "global",
    );
    if (userSection?.type !== "managedMarkdownSection") {
      throw new Error("expected markdown section");
    }
    expect(userSection.path).toBe(path.join(tmp, "home", ".cline", "rules", "default.md"));
  });
});

describe("cline: import", () => {
  it("parses streamableHttp and legacy typeless SSE entries", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".cline", "data", "settings");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "cline_mcp_settings.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            type: "streamableHttp",
            url: "https://example.com/mcp",
            headers: { Authorization: "${env:API_TOKEN}" },
          },
          legacy: { url: "https://example.com/sse" },
        },
      }),
    );

    const result = await clineAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["docs"]).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: { fromEnv: "API_TOKEN" } },
      enabled: true,
    });
    // A typeless URL entry defaults to legacy SSE (cline backwards-compat).
    expect(result.mcpServers["legacy"]).toEqual({
      transport: "sse",
      url: "https://example.com/sse",
      enabled: true,
    });
  });
});
