import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CanonicalPack, ImportContext } from "@agentpack/schema";
import { upsertManagedSection } from "@agentpack/filesystem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexAdapter } from "../src/index.js";
import { makeContext, makeDetection } from "./helpers.js";

const adapter = new CodexAdapter();

const CONFIG_TOML = [
  "[mcp_servers.github]",
  'command = "gh-mcp"',
  'args = ["serve"]',
  'env = { GITHUB_TOKEN = "${GH_TOKEN}", MODE = "fast", API_URL = "https://${HOST}/api" }',
  'env_vars = ["PATH", "HOME"]',
  "",
  "[mcp_servers.docs]",
  'url = "https://docs.example.com/mcp"',
  'http_headers = { Authorization = "${DOCS_TOKEN}" }',
  "startup_timeout_ms = 5000",
  "",
  "[mcp_servers.lab]",
  'command = "lab"',
  "experimental_feature = true",
  "",
].join("\n");

const SKILL_MD = [
  "---",
  "name: review",
  "description: Review code carefully",
  "---",
  "",
  "# Review",
  "",
].join("\n");

describe("import", () => {
  let tmpDir: string;
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-codex-import-"));
    projectRoot = path.join(tmpDir, "repo");
    homeDir = path.join(tmpDir, "home");
    await fs.mkdir(path.join(projectRoot, ".codex"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, ".codex", "config.toml"), CONFIG_TOML);
    const agents = upsertManagedSection(
      upsertManagedSection(undefined, "rules", "Follow the rules."),
      "style",
      "Use tabs.",
    );
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), agents);
    const skillDir = path.join(projectRoot, ".agents", "skills", "review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), SKILL_MD);
    await fs.writeFile(path.join(skillDir, "helper.txt"), "helper content");
    await fs.mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function importContext(scope: "project" | "user", env = {}): ImportContext {
    return { scope, projectRoot, homeDir, env, options: {} };
  }

  it("maps config.toml mcp_servers back to canonical servers", async () => {
    const imported = await adapter.import(importContext("project"));
    expect(imported.warnings).toEqual([]);
    expect(imported.mcpServers.github).toEqual({
      transport: "stdio",
      enabled: true,
      command: "gh-mcp",
      args: ["serve"],
      env: {
        GITHUB_TOKEN: { fromEnv: "GH_TOKEN" },
        MODE: { value: "fast" },
        API_URL: { template: "https://${HOST}/api", requiredEnv: ["HOST"] },
      },
      passEnv: ["PATH", "HOME"],
    });
    expect(imported.mcpServers.docs).toEqual({
      transport: "http",
      enabled: true,
      url: "https://docs.example.com/mcp",
      headers: { Authorization: { fromEnv: "DOCS_TOKEN" } },
      startupTimeoutMs: 5000,
    });
    expect(imported.mcpServers.lab).toEqual({
      transport: "stdio",
      enabled: true,
      command: "lab",
    });
  });

  it("collects unknown mcp_servers keys under extensions.configToml", async () => {
    const imported = await adapter.import(importContext("project"));
    expect(imported.extensions).toEqual({
      configToml: { mcpServers: { lab: { experimental_feature: true } } },
    });
  });

  it("imports managed sections of AGENTS.md as instructions", async () => {
    const imported = await adapter.import(importContext("project"));
    expect(imported.instructions).toEqual([
      { id: "rules", content: "Follow the rules.", scope: "project" },
      { id: "style", content: "Use tabs.", scope: "project" },
    ]);
  });

  it("imports skills with files, frontmatter and a content hash", async () => {
    const imported = await adapter.import(importContext("project"));
    expect(imported.skills).toHaveLength(1);
    const skill = imported.skills[0]!;
    expect(skill.name).toBe("review");
    expect(skill.description).toBe("Review code carefully");
    expect(Object.keys(skill.files).sort()).toEqual(["SKILL.md", "helper.txt"]);
    expect(skill.files["helper.txt"]).toBe("helper content");
    expect(skill.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("imports a plain user-scope AGENTS.md as one imported-codex instruction", async () => {
    const userRoot = path.join(homeDir, ".codex");
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(path.join(userRoot, "AGENTS.md"), "Global guidance.\n");
    const imported = await adapter.import(importContext("user"));
    expect(imported.instructions).toEqual([
      { id: "imported-codex", content: "Global guidance.\n", scope: "global" },
    ]);
    expect(imported.mcpServers).toEqual({});
    expect(imported.skills).toEqual([]);
  });

  it("honors CODEX_HOME for the user config root", async () => {
    const customRoot = path.join(tmpDir, "custom-codex");
    await fs.mkdir(customRoot, { recursive: true });
    await fs.writeFile(path.join(customRoot, "config.toml"), CONFIG_TOML);
    const imported = await adapter.import(importContext("user", { CODEX_HOME: customRoot }));
    expect(Object.keys(imported.mcpServers).sort()).toEqual(["docs", "github", "lab"]);
  });

  it("returns empty results when nothing exists", async () => {
    const imported = await adapter.import({
      scope: "project",
      projectRoot: path.join(tmpDir, "nowhere"),
      homeDir,
      env: {},
      options: {},
    });
    expect(imported).toEqual({
      skills: [],
      mcpServers: {},
      instructions: [],
      extensions: {},
      warnings: [],
    });
  });

  it("warns on unparseable config.toml instead of throwing", async () => {
    await fs.writeFile(path.join(projectRoot, ".codex", "config.toml"), "[unclosed");
    const imported = await adapter.import(importContext("project"));
    expect(imported.warnings).toHaveLength(1);
    expect(imported.warnings[0]).toContain("could not parse");
    expect(imported.mcpServers).toEqual({});
  });

  it("round-trips imported data back through generate", async () => {
    const imported = await adapter.import(importContext("project"));
    const pack: CanonicalPack = {
      metadata: { name: "roundtrip", version: "1.0.0" },
      rootDir: projectRoot,
      skills: imported.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        rootDir: path.join(projectRoot, ".agents", "skills", skill.name),
        files: Object.keys(skill.files).sort(),
        frontmatter: { name: skill.name, description: skill.description },
      })),
      instructions: imported.instructions.map((instruction) => ({
        ...instruction,
        sourcePath: path.join(projectRoot, "AGENTS.md"),
        priority: 100,
        mergeStrategy: "managed-section" as const,
      })),
      mcpServers: Object.fromEntries(
        Object.entries(imported.mcpServers).map(([name, server]) => [name, { ...server, name }]),
      ),
      hooks: [],
      targetExtensions: {},
      targetEnabled: {},
    };

    const context = makeContext({
      projectRoot,
      detection: makeDetection({
        projectConfigRoot: path.join(projectRoot, ".codex"),
      }),
    });
    const artifacts = await adapter.generate(pack, context);

    const toml = artifacts.filter((a) => a.kind === "toml-merge");
    expect(toml.map((a) => (a.kind === "toml-merge" ? a.table[1] : "")).sort()).toEqual([
      "docs",
      "github",
      "lab",
    ]);
    const github = toml.find((a) => a.kind === "toml-merge" && a.table[1] === "github");
    expect(github?.kind === "toml-merge" && github.value).toEqual({
      command: "gh-mcp",
      args: ["serve"],
      env: {
        GITHUB_TOKEN: "${GH_TOKEN}",
        MODE: "fast",
        API_URL: "https://${HOST}/api",
      },
      env_vars: ["PATH", "HOME"],
    });
    const docs = toml.find((a) => a.kind === "toml-merge" && a.table[1] === "docs");
    expect(docs?.kind === "toml-merge" && docs.value).toEqual({
      url: "https://docs.example.com/mcp",
      http_headers: { Authorization: "${DOCS_TOKEN}" },
      startup_timeout_ms: 5000,
    });

    const sections = artifacts.filter((a) => a.kind === "markdown-section");
    expect(sections.map((a) => (a.kind === "markdown-section" ? a.sectionId : ""))).toEqual([
      "rules",
      "style",
    ]);

    const skills = artifacts.filter((a) => a.kind === "skill");
    expect(skills.map((a) => (a.kind === "skill" ? a.name : ""))).toEqual(["review"]);
  });
});
