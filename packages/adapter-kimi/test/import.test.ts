import { promises as fs } from "node:fs";
import path from "node:path";

import type { CanonicalMcpServer, CanonicalPack, ImportContext } from "@agentpack/schema";
import { describe, expect, it } from "vitest";

import { generateKimi } from "../src/generate.js";
import { importKimi } from "../src/import.js";
import { makeContext, makePack, makeTmpDir } from "./helpers.js";

function importContext(tmp: string, overrides: Partial<ImportContext> = {}): ImportContext {
  return {
    scope: "project",
    projectRoot: path.join(tmp, "project"),
    homeDir: path.join(tmp, "home"),
    env: {},
    options: {},
    ...overrides,
  };
}

const NATIVE_MCP = {
  mcpServers: {
    github: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" },
      passEnv: ["HOME"],
      approval: { default: "always" },
      allowTools: ["get_issue"],
      customField: { vendor: true },
    },
    docs: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ${API_TOKEN}" },
    },
  },
};

async function writeNativeProject(tmp: string): Promise<void> {
  const project = path.join(tmp, "project");
  await fs.mkdir(path.join(project, ".kimi-code"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".kimi-code", "mcp.json"),
    `${JSON.stringify(NATIVE_MCP, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project, "AGENTS.md"),
    [
      "# Team notes",
      "",
      "<!-- agentpack:begin coding-style -->",
      "Use strict TypeScript.",
      "<!-- agentpack:end coding-style -->",
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(project, ".kimi-code", "AGENTS.md"), "Always run tests first.\n");

  const skillDir = path.join(project, ".agents", "skills", "review");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    ["---", "name: review", "description: Review code", "---", "", "# Review", ""].join("\n"),
  );
  await fs.writeFile(path.join(skillDir, "reference.md"), "Checklist items.\n");
}

describe("importKimi", () => {
  it("maps native mcp.json back to canonical specs and extensions", async () => {
    const tmp = await makeTmpDir();
    await writeNativeProject(tmp);

    const imported = await importKimi(importContext(tmp));

    expect(imported.mcpServers.github).toEqual({
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" }, LOG_LEVEL: { value: "debug" } },
      passEnv: ["HOME"],
      approval: { default: "always" },
      allowTools: ["get_issue"],
    });
    expect(imported.mcpServers.docs).toEqual({
      transport: "http",
      enabled: true,
      url: "https://example.com/mcp",
      headers: { Authorization: { template: "Bearer ${API_TOKEN}", requiredEnv: ["API_TOKEN"] } },
    });
    expect(imported.extensions).toEqual({
      mcpServerExtensions: { github: { customField: { vendor: true } } },
    });
    expect(imported.warnings).toEqual([]);
  });

  it("imports managed sections per section and whole files as imported-kimi", async () => {
    const tmp = await makeTmpDir();
    await writeNativeProject(tmp);

    const imported = await importKimi(importContext(tmp));

    expect(imported.instructions).toEqual([
      { id: "coding-style", content: "Use strict TypeScript.", scope: "project" },
      { id: "imported-kimi", content: "Always run tests first.", scope: "project" },
    ]);
  });

  it("imports skills with frontmatter and a deterministic content hash", async () => {
    const tmp = await makeTmpDir();
    await writeNativeProject(tmp);

    const imported = await importKimi(importContext(tmp));

    expect(imported.skills).toHaveLength(1);
    const skill = imported.skills[0]!;
    expect(skill.name).toBe("review");
    expect(skill.description).toBe("Review code");
    expect(Object.keys(skill.files).sort()).toEqual(["SKILL.md", "reference.md"]);
    expect(skill.files["reference.md"]).toBe("Checklist items.\n");
    expect(skill.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("reads user-scope config from $KIMI_CODE_HOME", async () => {
    const tmp = await makeTmpDir();
    const kimiHome = path.join(tmp, "kimi-home");
    await fs.mkdir(kimiHome, { recursive: true });
    await fs.writeFile(
      path.join(kimiHome, "mcp.json"),
      JSON.stringify({ mcpServers: { docs: NATIVE_MCP.mcpServers.docs } }),
    );
    await fs.writeFile(path.join(kimiHome, "AGENTS.md"), "Global rules.\n");
    const skillDir = path.join(tmp, "home", ".agents", "skills", "notes");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: notes\n---\n# Notes\n");

    const imported = await importKimi(
      importContext(tmp, { scope: "user", env: { KIMI_CODE_HOME: kimiHome } }),
    );

    expect(Object.keys(imported.mcpServers)).toEqual(["docs"]);
    expect(imported.instructions).toEqual([
      { id: "imported-kimi", content: "Global rules.", scope: "global" },
    ]);
    expect(imported.skills.map((s) => s.name)).toEqual(["notes"]);
  });

  it("round-trips: native → import → canonical → generate is semantically equal", async () => {
    const tmp = await makeTmpDir();
    await writeNativeProject(tmp);

    const imported = await importKimi(importContext(tmp));

    // Materialize the imported skills so the canonical pack can reference them.
    const packDir = path.join(tmp, "pack");
    const skills = [];
    for (const skill of imported.skills) {
      const rootDir = path.join(packDir, "skills", skill.name);
      for (const [rel, content] of Object.entries(skill.files)) {
        const dest = path.join(rootDir, ...rel.split("/"));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content);
      }
      skills.push({
        name: skill.name,
        description: skill.description,
        rootDir,
        files: Object.keys(skill.files).sort(),
        frontmatter: { name: skill.name, description: skill.description },
      });
    }

    const mcpServers: Record<string, CanonicalMcpServer> = {};
    for (const [name, spec] of Object.entries(imported.mcpServers)) {
      mcpServers[name] = { ...spec, name };
    }

    const pack: CanonicalPack = makePack(packDir, {
      skills,
      mcpServers,
      instructions: imported.instructions.map((instruction) => ({
        id: instruction.id,
        sourcePath: path.join(packDir, "instructions", `${instruction.id}.md`),
        content: instruction.content,
        scope: instruction.scope,
        directory: instruction.directory,
        priority: 100,
        mergeStrategy: "managed-section" as const,
      })),
    });

    const artifacts = await generateKimi(pack, makeContext(tmp));

    // MCP servers regenerate the same native entries (minus unknown keys).
    const merges = artifacts.filter((a) => a.kind === "json-merge" && a.relPath === "mcp.json");
    expect(merges).toHaveLength(2);
    const byPointer = new Map(
      merges.map((m) => [(m as { pointer: string }).pointer, (m as { value: unknown }).value]),
    );
    const expectedGithub = { ...NATIVE_MCP.mcpServers.github } as Record<string, unknown>;
    delete expectedGithub.customField;
    expect(byPointer.get("/mcpServers/github")).toEqual(expectedGithub);
    expect(byPointer.get("/mcpServers/docs")).toEqual(NATIVE_MCP.mcpServers.docs);

    // Instructions regenerate the same managed sections.
    const sections = artifacts.filter((a) => a.kind === "markdown-section");
    expect(sections).toEqual([
      {
        kind: "markdown-section",
        root: "projectConfig",
        relPath: "AGENTS.md",
        sectionId: "coding-style",
        content: "Use strict TypeScript.",
        append: undefined,
      },
      {
        kind: "markdown-section",
        root: "projectConfig",
        relPath: "AGENTS.md",
        sectionId: "imported-kimi",
        content: "Always run tests first.",
        append: undefined,
      },
    ]);

    // Skills regenerate as installable directory artifacts.
    const skillArtifacts = artifacts.filter((a) => a.kind === "skill");
    expect(skillArtifacts).toEqual([
      {
        kind: "skill",
        root: "projectConfig",
        name: "review",
        sourceDir: path.join(packDir, "skills", "review"),
        relPath: "skills/review",
      },
    ]);
  });

  it("warns and skips invalid entries without failing", async () => {
    const tmp = await makeTmpDir();
    const project = path.join(tmp, "project");
    await fs.mkdir(path.join(project, ".kimi-code"), { recursive: true });
    await fs.writeFile(
      path.join(project, ".kimi-code", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          broken: { command: "npx" },
          bad: "nope",
          ok: { type: "stdio", command: "ok" },
        },
      }),
    );

    const imported = await importKimi(importContext(tmp));

    expect(Object.keys(imported.mcpServers)).toEqual(["ok"]);
    expect(imported.warnings).toHaveLength(2);
  });
});
