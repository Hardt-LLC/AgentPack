import { promises as fs } from "node:fs";
import path from "node:path";

import { mergeYamlAtPointer } from "@agentpack/filesystem";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { hermesAdapter } from "../src/hermes.js";
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
  stdioServer,
} from "./helpers.js";

describe("hermes: detection", () => {
  it("detects the hermes binary; HERMES_HOME relocates the root", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "hermes", "4.2.0");
    const hermesHome = path.join(tmp, "hermes-home");
    const detection = await hermesAdapter.detect({
      env: { HERMES_HOME: hermesHome },
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "hermes" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "4.2.0",
      userConfigRoot: hermesHome,
    });
  });
});

describe("hermes: MCP server values", () => {
  it("emits implicit-transport entries under mcp_servers", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await hermesAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "json-merge");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/mcp_servers/github",
      "/mcp_servers/docs",
    ]);

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

  it("plans mergeYaml ops against config.yaml and produces re-readable YAML", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const hermesHome = path.join(tmp, "hermes-home");
    const env = { HERMES_HOME: hermesHome };

    const ops = await hermesAdapter.planInstall(
      await hermesAdapter.generate(pack, makeContext(tmp, { scope: "user", env })),
      makeInstallContext(tmp, { scope: "user", env }),
    );
    const merge = ops.find((o) => o.type === "mergeYaml");
    if (merge?.type !== "mergeYaml") throw new Error("expected mergeYaml");
    expect(merge.path).toBe(path.join(hermesHome, "config.yaml"));
    expect(merge.pointer).toBe("/mcp_servers/github");
    expect(ops.some((o) => o.type === "mergeJson")).toBe(false);

    // Apply the merge onto existing YAML and confirm the result re-parses.
    const merged = mergeYamlAtPointer("theme: dark\n", merge.pointer, merge.value);
    const parsed = parseYaml(merged) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect((servers.github as Record<string, unknown>).command).toBe("npx");
  });

  it("degrades project-scope MCP (no project config file)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const report = await hermesAdapter.analyze(pack, makeContext(tmp));
    expect(report.findings).toEqual([
      expect.objectContaining({ componentType: "mcp", support: "degraded" }),
    ]);
  });
});

describe("hermes: instructions", () => {
  it("writes project .hermes.md; user instructions unsupported (SOUL.md is not managed)", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      instructions: [projectInstruction, globalInstruction],
    });

    const projectOps = await hermesAdapter.planInstall(
      await hermesAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const section = projectOps.find(
      (o) => o.type === "managedMarkdownSection" && o.sectionId === "coding-style",
    );
    if (section?.type !== "managedMarkdownSection") throw new Error("expected markdown section");
    expect(section.path).toBe(path.join(tmp, "project", ".hermes.md"));

    const report = await hermesAdapter.analyze(pack, makeContext(tmp, { scope: "user" }));
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        componentType: "instruction",
        componentId: "global-style",
        support: "unsupported",
      }),
    );
  });
});

describe("hermes: import", () => {
  it("round-trips mcp_servers from config.yaml", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".hermes");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.yaml"),
      [
        "mcp_servers:",
        "  filesystem:",
        '    command: "npx"',
        '    args: ["-y", "@modelcontextprotocol/server-filesystem"]',
        "    env:",
        '      GITHUB_TOKEN: "${GITHUB_TOKEN}"',
        "  linear:",
        '    url: "https://mcp.linear.app/mcp"',
        "",
      ].join("\n"),
    );

    const result = await hermesAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["filesystem"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      enabled: true,
    });
    expect(result.mcpServers["linear"]).toEqual({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
    });
  });
});
