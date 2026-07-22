import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { kiloAdapter } from "../src/kilo.js";
import {
  httpServer,
  makeContext,
  makeExecutable,
  makeImportContext,
  makeInstallContext,
  makePack,
  makeTmpDir,
  skill,
  stdioServer,
} from "./helpers.js";

describe("kilo: detection", () => {
  it("uses the current ~/.config/kilo layout", async () => {
    const tmp = await makeTmpDir();
    const exe = await makeExecutable(path.join(tmp, "bin"), "kilo", "0.4.0");
    const detection = await kiloAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async (name) => (name === "kilo" ? exe : undefined),
    });
    expect(detection).toMatchObject({
      installed: true,
      version: "0.4.0",
      userConfigRoot: path.join(tmp, "home", ".config", "kilo"),
      projectConfigRoot: path.join(tmp, "project", ".kilo"),
      warnings: [],
    });
  });

  it("warns when only the legacy layout exists", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "home", ".kilocode"), { recursive: true });
    const detection = await kiloAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async () => undefined,
    });
    expect(detection.installed).toBe(true);
    expect(detection.warnings).toHaveLength(1);
    expect(detection.warnings[0]).toContain("legacy Kilo Code layout");
  });

  it("does not warn when the current layout exists alongside a legacy one", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "home", ".config", "kilo"), { recursive: true });
    await fs.mkdir(path.join(tmp, "home", ".kilocode"), { recursive: true });
    const detection = await kiloAdapter.detect({
      env: {},
      homeDir: path.join(tmp, "home"),
      projectRoot: path.join(tmp, "project"),
      platform: process.platform,
      findExecutable: async () => undefined,
    });
    expect(detection.installed).toBe(true);
    expect(detection.warnings).toEqual([]);
  });
});

describe("kilo: MCP server values (opencode-style)", () => {
  it("uses local/remote types, command arrays and the environment key", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: { github: stdioServer, docs: httpServer },
    });
    const artifacts = await kiloAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
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

  it("plans mergeYaml ops against kilo.jsonc for both scopes", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { github: stdioServer } });

    const userOps = await kiloAdapter.planInstall(
      await kiloAdapter.generate(pack, makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeYaml");
    if (userMerge?.type !== "mergeYaml") throw new Error("expected mergeYaml");
    expect(userMerge.path).toBe(path.join(tmp, "home", ".config", "kilo", "kilo.jsonc"));
    expect(userMerge.pointer).toBe("/mcp/github");
    expect(userOps.some((o) => o.type === "mergeJson")).toBe(false);

    const projectOps = await kiloAdapter.planInstall(
      await kiloAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp),
    );
    const projectMerge = projectOps.find((o) => o.type === "mergeYaml");
    if (projectMerge?.type !== "mergeYaml") throw new Error("expected mergeYaml");
    expect(projectMerge.path).toBe(path.join(tmp, "project", "kilo.jsonc"));
  });
});

describe("kilo: skills", () => {
  it("supports project-scope skills only", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { skills: [skill] });

    const projectReport = await kiloAdapter.analyze(pack, makeContext(tmp));
    expect(projectReport.findings).toEqual([
      expect.objectContaining({ componentType: "skill", support: "native" }),
    ]);
    const projectOps = await kiloAdapter.planInstall(
      await kiloAdapter.generate(pack, makeContext(tmp)),
      makeInstallContext(tmp, { installMode: "copy" }),
    );
    const copy = projectOps.find((o) => o.type === "copyDirectory");
    if (copy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
    expect(copy.dest).toBe(path.join(tmp, "project", ".kilocode", "skills", "review"));

    const userReport = await kiloAdapter.analyze(pack, makeContext(tmp, { scope: "user" }));
    expect(userReport.findings).toEqual([
      expect.objectContaining({
        componentType: "skill",
        support: "unsupported",
        message: "kilo has no documented user-scope skills directory",
      }),
    ]);
    const userArtifacts = await kiloAdapter.generate(pack, makeContext(tmp, { scope: "user" }));
    expect(userArtifacts.filter((a) => a.kind === "skill")).toEqual([]);
  });
});

describe("kilo: import", () => {
  it("round-trips kilo.jsonc entries via the YAML engine", async () => {
    const tmp = await makeTmpDir();
    const kiloDir = path.join(tmp, "home", ".config", "kilo");
    await fs.mkdir(kiloDir, { recursive: true });
    await fs.writeFile(
      path.join(kiloDir, "kilo.jsonc"),
      [
        "{",
        '  "mcp": {',
        '    "github": {',
        '      "type": "local",',
        '      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],',
        '      "environment": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }',
        "    },",
        '    "docs": { "type": "remote", "url": "https://example.com/mcp" }',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await kiloAdapter.import!(makeImportContext(tmp));
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

  it("watches only kilo.jsonc as a native source (no global skills dir)", async () => {
    const tmp = await makeTmpDir();
    const sources = await kiloAdapter.nativeSources!(makeImportContext(tmp));
    expect(sources).toEqual([path.join(tmp, "home", ".config", "kilo", "kilo.jsonc")]);
  });
});
