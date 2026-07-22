import { promises as fs } from "node:fs";
import path from "node:path";

import { mergeJsonAtPointer } from "@agentpack/filesystem";
import { describe, expect, it } from "vitest";

import { openclawAdapter } from "../src/openclaw.js";
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
  sseServer,
  stdioServer,
} from "./helpers.js";

describe("openclaw: detection", () => {
  it("detects the openclaw binary and ~/.openclaw root", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "openclaw", "2.1.0");
    const detection = await openclawAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "openclaw" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "2.1.0",
      userConfigRoot: path.join(tmp, "home", ".openclaw"),
    });
  });
});

describe("openclaw: MCP server values", () => {
  it("uses transport streamable-http/sse for remotes, bare shape for stdio", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer, events: sseServer },
    });
    const artifacts = await openclawAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/mcp/servers/github",
      "/mcp/servers/docs",
      "/mcp/servers/events",
    ]);

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
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    expect(docs.value).toEqual({
      url: "https://example.com/mcp",
      transport: "streamable-http",
      headers: { Authorization: "${API_TOKEN}" },
    });
    expect(events.value).toEqual({
      url: "https://example.com/sse",
      transport: "sse",
    });
  });

  it("merges into ~/.openclaw/openclaw.json and degrades project scope", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await openclawAdapter.planInstall(
      await openclawAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const merge = userOps.find((o) => o.type === "mergeJson");
    if (merge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(merge.path).toBe(path.join(tmp, "home", ".openclaw", "openclaw.json"));

    const report = await openclawAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({ componentType: "mcp", support: "degraded" }),
    ]);
  });
});

describe("openclaw: JSON5 format decision", () => {
  it("merge output stays strict JSON (valid JSON5 input) and preserves other keys", async () => {
    // Decision recorded in src/openclaw.ts: writes use mergeJson because
    // strict JSON is valid JSON5, while YAML-styled output would not be.
    const existing = JSON.stringify(
      { theme: "dark", mcp: { servers: { other: { command: "x" } } } },
      null,
      2,
    );
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const artifacts = await openclawAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merge = artifacts.find((a) => a.kind === "json-merge");
    if (merge?.kind !== "json-merge") throw new Error("expected json-merge");

    const merged = mergeJsonAtPointer(existing, merge.pointer, merge.value);
    const parsed = JSON.parse(merged) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    const servers = (parsed.mcp as Record<string, unknown>).servers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["github", "other"]);
  });

  it("import of a JSON5 file with comments degrades to a warning, not a crash", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".openclaw");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "openclaw.json"),
      '{\n  // JSON5 comment\n  "mcp": { "servers": {}, },\n}\n',
    );
    const result = await openclawAdapter.import!(makeImportContext(tmp));
    expect(result.mcpServers).toEqual({});
    expect(result.warnings.some((w) => w.includes("failed to parse"))).toBe(true);
  });
});

describe("openclaw: skills and instructions", () => {
  it("supports user skills only", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });

    const userReport = await openclawAdapter.analyze(pack, makeContext(tmp, { scope: "user" }));
    expect(userReport.findings).toEqual([
      expect.objectContaining({ componentType: "skill", support: "native" }),
    ]);

    const projectReport = await openclawAdapter.analyze(pack, makeContext(tmp));
    expect(projectReport.findings).toEqual([
      expect.objectContaining({
        componentType: "skill",
        support: "unsupported",
        message: "openclaw has no documented project-scope skills directory",
      }),
    ]);
  });

  it("writes the default workspace AGENTS.md; project instructions unsupported", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [globalInstruction, projectInstruction],
    });

    const userOps = await openclawAdapter.planInstall(
      await openclawAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const section = userOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "global-style",
    );
    if (section?.type !== "managedMarkdownSection") throw new Error("expected markdown section");
    expect(section.path).toBe(path.join(tmp, "home", ".openclaw", "workspace", "AGENTS.md"));

    const report = await openclawAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        componentType: "instruction",
        componentId: "coding-style",
        support: "unsupported",
      }),
    );
  });
});

describe("openclaw: import", () => {
  it("round-trips mcp.servers entries including the transport key", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".openclaw");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "openclaw.json"),
      JSON.stringify({
        mcp: {
          servers: {
            context7: { command: "uvx", args: ["context7-mcp"], env: { KEY: "${MY_KEY}" } },
            docs: {
              url: "https://mcp.example.com/mcp",
              transport: "streamable-http",
              headers: { Authorization: "Bearer ${MCP_REMOTE_TOKEN}" },
            },
            legacy: { url: "https://mcp.example.com/sse" },
          },
        },
      }),
    );

    const result = await openclawAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["context7"]).toEqual({
      transport: "stdio",
      command: "uvx",
      args: ["context7-mcp"],
      env: { KEY: { fromEnv: "MY_KEY" } },
      enabled: true,
    });
    expect(result.mcpServers["docs"]).toEqual({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: {
          template: "Bearer ${MCP_REMOTE_TOKEN}",
          requiredEnv: ["MCP_REMOTE_TOKEN"],
        },
      },
      enabled: true,
    });
    // Omitted transport defaults to SSE per the sheet.
    expect(result.mcpServers["legacy"]).toEqual({
      transport: "sse",
      url: "https://mcp.example.com/sse",
      enabled: true,
    });
  });
});
