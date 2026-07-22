import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cursorAdapter } from "../src/cursor.js";
import {
  directoryInstruction,
  globalInstruction,
  hook,
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makePack,
  makeTmpDir,
  projectInstruction,
  stdioServer,
} from "./helpers.js";

describe("cursor: detection", () => {
  it("reports config roots and probed version", async () => {
    const tmp = await makeTmpDir();
    const cursorPath = await makeExecutable(path.join(tmp, "bin"), "cursor", "1.7.23");
    const detection = await cursorAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "cursor" ? cursorPath : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      executablePath: cursorPath,
      version: "1.7.23",
      userConfigRoot: path.join(tmp, "home", ".cursor"),
      projectConfigRoot: path.join(tmp, "project", ".cursor"),
      warnings: [],
    });
  });

  it("warns when the version probe fails but still reports installed", async () => {
    const tmp = await makeTmpDir();
    const broken = await makeExecutable(path.join(tmp, "bin"), "cursor");
    const detection = await cursorAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "cursor" ? broken : undefined),
    });
    expect(detection.installed).toBe(true);
    expect(detection.version).toBeUndefined();
    expect(detection.warnings).toHaveLength(1);
    expect(detection.warnings[0]).toContain("--version");
  });
});

describe("cursor: MCP server values", () => {
  it("matches the documented mcp.json shapes exactly", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await cursorAdapter.generate(pack, makeContext(tmp));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/mcpServers/github",
      "/mcpServers/docs",
    ]);

    const github = merges[0];
    if (github?.kind !== "json-merge") throw new Error("expected json-merge");
    // stdio: command/args/env, NO "type" key (cursor docs).
    expect(github.value).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });

    const docs = merges[1];
    if (docs?.kind !== "json-merge") throw new Error("expected json-merge");
    // remote: url + headers, no "type" (url selects HTTP/SSE).
    expect(docs.value).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "${env:API_TOKEN}" },
    });
  });
});

describe("cursor: instructions", () => {
  it("writes project and directory instructions as AGENTS.md files", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, directoryInstruction],
    });
    const artifacts = await cursorAdapter.generate(pack, makeContext(tmp));
    const sections = artifacts.filter((a) => a.kind === "markdown-section");
    expect(sections.map((s) => (s.kind === "markdown-section" ? s.relPath : ""))).toEqual([
      "AGENTS.md",
      "src/AGENTS.md",
    ]);
  });

  it("classifies global instructions as unsupported (Settings UI has no file)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { instructions: [globalInstruction] });
    const report = await cursorAdapter.analyze(pack, makeContext(tmp, { scope: "user" }));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "instruction",
        componentId: "global-style",
        support: "unsupported",
      }),
    ]);
    const artifacts = await cursorAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    expect(artifacts).toEqual([]);
  });
});

describe("cursor: hooks", () => {
  it("classifies hooks as transpiled and merges flat arrays per event", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { hooks: [hook] });
    const report = await cursorAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({
        componentType: "hook",
        componentId: "lint",
        support: "transpiled",
        message: "rendered to hooks.json",
      }),
    ]);

    const artifacts = await cursorAdapter.generate(pack, makeContext(tmp));
    const merge = artifacts.find((a) => a.kind === "json-merge" && a.relPath === "hooks.json");
    if (merge?.kind !== "json-merge") throw new Error("expected hooks json-merge");
    expect(merge.pointer).toBe("/hooks/preToolUse");
    expect(merge.value).toEqual([{ command: "pnpm lint", matcher: "shell" }]);
  });
});

describe("cursor: import", () => {
  it("round-trips mcp.json entries back to canonical form", async () => {
    const tmp = await makeTmpDir();
    const cursorDir = path.join(tmp, "home", ".cursor");
    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", LOG_LEVEL: "debug" },
          },
          docs: { url: "https://example.com/mcp", headers: { Authorization: "${env:API_TOKEN}" } },
        },
      }),
    );

    const result = await cursorAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["github"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" }, LOG_LEVEL: { value: "debug" } },
      enabled: true,
    });
    expect(result.mcpServers["docs"]).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: { fromEnv: "API_TOKEN" } },
      enabled: true,
    });
  });

  it("imports skills from the user skills directory", async () => {
    const tmp = await makeTmpDir();
    const skillDir = path.join(tmp, "home", ".cursor", "skills", "review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n# Review\n",
    );

    const result = await cursorAdapter.import!(makeImportContext(tmp));
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "review",
      description: "Review code",
    });
    expect(result.skills[0]?.files["SKILL.md"]).toContain("# Review");
  });

  it("watches the user mcp.json and skills dir as native sources", async () => {
    const tmp = await makeTmpDir();
    const sources = await cursorAdapter.nativeSources!(makeImportContext(tmp));
    expect(sources).toEqual([
      path.join(tmp, "home", ".cursor", "mcp.json"),
      path.join(tmp, "home", ".cursor", "skills"),
    ]);
  });
});
