import { promises as fs } from "node:fs";
import path from "node:path";

import { mergeTomlAtTable } from "@agentpack/filesystem";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

import { vibeAdapter } from "../src/vibe.js";
import {
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  stdioServer,
} from "./helpers.js";

describe("vibe: detection", () => {
  it("detects the vibe binary; VIBE_HOME relocates the root", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "vibe", "1.1.0");
    const vibeHome = path.join(tmp, "vibe-home");
    const detection = await vibeAdapter.detect({
      env: { VIBE_HOME: vibeHome },
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "vibe" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "1.1.0",
      userConfigRoot: vibeHome,
      projectConfigRoot: path.join(tmp, "project", ".vibe"),
    });
  });
});

describe("vibe: MCP server values", () => {
  it("emits named tables with explicit transport", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await vibeAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    const merges = artifacts.filter((a) => a.kind === "toml-merge");
    expect(merges.map((m) => (m.kind === "toml-merge" ? m.table.join(".") : ""))).toEqual([
      "mcp_servers.github",
      "mcp_servers.docs",
    ]);

    const [github, docs] = merges;
    if (github?.kind !== "toml-merge" || docs?.kind !== "toml-merge") {
      throw new Error("expected toml-merge artifacts");
    }
    expect(github.value).toEqual({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" },
    });
    expect(docs.value).toEqual({
      name: "docs",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      headers: { Authorization: "${API_TOKEN}" },
    });
  });

  it("plans mergeToml ops against config.toml for both scopes", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });
    const vibeHome = path.join(tmp, "vibe-home");
    const env = { VIBE_HOME: vibeHome };

    const userOps = await vibeAdapter.planInstall(
      await vibeAdapter.generate(pack, makeContext(tmp, { scope: "user", env })),
      makeInstallContext(tmp, { scope: "user", env }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeToml");
    if (userMerge?.type !== "mergeToml") throw new Error("expected mergeToml");
    expect(userMerge.path).toBe(path.join(vibeHome, "config.toml"));
    expect(userMerge.table).toEqual(["mcp_servers", "github"]);

    const projectOps = await vibeAdapter.planInstall(
      await vibeAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeToml");
    if (projectMerge?.type !== "mergeToml") throw new Error("expected mergeToml");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".vibe", "config.toml"));
  });
});

describe("vibe: [mcp_servers.x] inline-table form", () => {
  it("smol-toml reads merged [mcp_servers.<name>] tables correctly", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await vibeAdapter.generate(pack, makeContext(tmp, { scope: "user" }));

    let content: string | undefined = 'theme = "dark"\n';
    for (const artifact of artifacts) {
      if (artifact.kind !== "toml-merge") throw new Error("expected toml-merge");
      content = mergeTomlAtTable(content, artifact.table, artifact.value);
    }
    const parsed = parseToml(content!) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.github).toMatchObject({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(servers.docs).toMatchObject({
      name: "docs",
      transport: "streamable-http",
      url: "https://example.com/mcp",
    });
  });
});

describe("vibe: import", () => {
  it("round-trips the inline-table form", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".vibe");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.toml"),
      [
        "[mcp_servers.github]",
        'name = "github"',
        'transport = "stdio"',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-github"]',
        'env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }',
        "",
      ].join("\n"),
    );

    const result = await vibeAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["github"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
      enabled: true,
    });
  });

  it("also reads the canonical [[mcp_servers]] array-of-tables form", async () => {
    const tmp = await makeTmpDir();
    const dir = path.join(tmp, "home", ".vibe");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.toml"),
      [
        "[[mcp_servers]]",
        'name = "fetch_server"',
        'transport = "stdio"',
        'command = "uvx"',
        'args = ["mcp-server-fetch"]',
        "",
        "[[mcp_servers]]",
        'name = "linear"',
        'transport = "streamable-http"',
        'url = "https://mcp.linear.app/mcp"',
        "",
      ].join("\n"),
    );

    const result = await vibeAdapter.import!(makeImportContext(tmp));
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers["fetch_server"]).toEqual({
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-fetch"],
      enabled: true,
    });
    expect(result.mcpServers["linear"]).toEqual({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
    });
  });
});
