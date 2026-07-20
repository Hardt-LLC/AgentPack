import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { CanonicalPack, ImportContext } from "@agentpack/schema";

import { createClaudeAdapter } from "../src/index.js";
import { makeAdapterContext, makeInstallContext, makePack, makeTmpDir } from "./helpers.js";

function makeImportContext(tmp: string, scope: "project" | "user"): ImportContext {
  return {
    scope,
    projectRoot: path.join(tmp, "project"),
    homeDir: path.join(tmp, "home"),
    env: {},
    options: {},
  };
}

const MCP_JSON = {
  mcpServers: {
    github: {
      type: "stdio",
      command: "npx",
      args: ["-y", "srv"],
      env: {
        TOKEN: "${GH_TOKEN}",
        AUTH: "Bearer ${GH_TOKEN}",
        MODE: "debug",
      },
      startupTimeoutMs: 5000,
      timeout: 30000,
      customField: true,
    },
    web: { url: "https://example.com/mcp", headers: { "X-Api-Key": "${API_KEY}" } },
    legacy: { command: "srv" },
  },
};

const SETTINGS_JSON = {
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npm run lint" }] }],
  },
  theme: "dark",
};

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function setupProjectConfig(tmp: string): Promise<void> {
  const projectRoot = path.join(tmp, "project");
  await writeJson(path.join(projectRoot, ".mcp.json"), MCP_JSON);
  await writeJson(path.join(projectRoot, ".claude", "settings.json"), SETTINGS_JSON);
  await fs.writeFile(
    path.join(projectRoot, "CLAUDE.md"),
    "<!-- agentpack:begin style -->\nUse spaces.\n<!-- agentpack:end style -->\n",
  );
  const skillDir = path.join(projectRoot, ".claude", "skills", "alpha");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: alpha\ndescription: The alpha skill\n---\n\n# Alpha\n",
  );
  await fs.writeFile(path.join(skillDir, "extra.txt"), "extra\n");
}

describe("import", () => {
  it("reads project-scope native config into canonical form", async () => {
    const tmp = await makeTmpDir();
    await setupProjectConfig(tmp);
    const adapter = createClaudeAdapter();

    const imported = await adapter.import!(makeImportContext(tmp, "project"));

    expect(imported.warnings).toEqual([]);

    expect(imported.mcpServers.github).toEqual({
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "srv"],
      env: {
        TOKEN: { fromEnv: "GH_TOKEN" },
        AUTH: { template: "Bearer ${GH_TOKEN}", requiredEnv: ["GH_TOKEN"] },
        MODE: { value: "debug" },
      },
      startupTimeoutMs: 5000,
      toolTimeoutMs: 30000,
      extensions: { customField: true },
    });
    // Missing "type" with a url infers http.
    expect(imported.mcpServers.web).toEqual({
      transport: "http",
      enabled: true,
      url: "https://example.com/mcp",
      headers: { "X-Api-Key": { fromEnv: "API_KEY" } },
    });
    // Missing "type" with a command infers stdio.
    expect(imported.mcpServers.legacy).toEqual({
      transport: "stdio",
      enabled: true,
      command: "srv",
    });

    expect(imported.instructions).toEqual([
      { id: "style", content: "Use spaces.", scope: "project" },
    ]);

    expect(imported.skills).toHaveLength(1);
    const skill = imported.skills[0]!;
    expect(skill.name).toBe("alpha");
    expect(skill.description).toBe("The alpha skill");
    expect(Object.keys(skill.files).sort()).toEqual(["SKILL.md", "extra.txt"]);
    expect(skill.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(imported.extensions.hooks).toEqual(SETTINGS_JSON.hooks);
    expect(imported.extensions.importedHooks).toEqual([
      {
        id: "imported-pretooluse-0",
        event: "preToolUse",
        matcher: "Bash",
        command: ["/bin/sh", "-c", "npm run lint"],
      },
    ]);
    expect(imported.extensions.settings).toEqual({ theme: "dark" });
  });

  it("reads user-scope native config (~/.claude.json, ~/.claude/CLAUDE.md)", async () => {
    const tmp = await makeTmpDir();
    const homeDir = path.join(tmp, "home");
    await writeJson(path.join(homeDir, ".claude.json"), {
      mcpServers: { web: { type: "http", url: "https://example.com/mcp" } },
    });
    await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(homeDir, ".claude", "CLAUDE.md"), "Always be terse.\n");
    const adapter = createClaudeAdapter();

    const imported = await adapter.import!(makeImportContext(tmp, "user"));

    expect(imported.mcpServers.web).toEqual({
      transport: "http",
      enabled: true,
      url: "https://example.com/mcp",
    });
    // A whole-file CLAUDE.md without managed sections becomes one instruction.
    expect(imported.instructions).toEqual([
      { id: "imported-claude", content: "Always be terse.", scope: "global" },
    ]);
    expect(imported.skills).toEqual([]);
  });

  it("warns on invalid JSON instead of throwing", async () => {
    const tmp = await makeTmpDir();
    const projectRoot = path.join(tmp, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, ".mcp.json"), "{ not json");
    const adapter = createClaudeAdapter();

    const imported = await adapter.import!(makeImportContext(tmp, "project"));

    expect(imported.warnings).toHaveLength(1);
    expect(imported.warnings[0]).toContain("invalid JSON");
    expect(imported.mcpServers).toEqual({});
  });

  it("round-trips: native files → import → generate → semantically equal output", async () => {
    const tmp = await makeTmpDir();
    await setupProjectConfig(tmp);
    const adapter = createClaudeAdapter();

    const imported = await adapter.import!(makeImportContext(tmp, "project"));

    const mcpServers: CanonicalPack["mcpServers"] = {};
    for (const [name, server] of Object.entries(imported.mcpServers)) {
      mcpServers[name] = { ...server, name };
    }
    const pack = makePack({
      mcpServers,
      instructions: imported.instructions.map((instruction) => ({
        id: instruction.id,
        sourcePath: "/imported.md",
        content: instruction.content,
        scope: instruction.scope,
        directory: instruction.directory,
        priority: 100,
        mergeStrategy: "managed-section" as const,
      })),
      hooks: (imported.extensions.importedHooks ?? []) as CanonicalPack["hooks"],
    });

    const artifacts = await adapter.generate(pack, makeAdapterContext(tmp, "project"));
    const ops = await adapter.planInstall(artifacts, makeInstallContext(tmp, "project"));

    const merges = ops.filter((op) => op.type === "mergeJson");
    const byPointer = new Map(merges.map((op) => [op.pointer, op.value]));

    // Servers re-render exactly as the native file described them (unknown
    // keys stay in extensions and are not rendered back).
    expect(byPointer.get("/mcpServers/github")).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "srv"],
      env: { TOKEN: "${GH_TOKEN}", AUTH: "Bearer ${GH_TOKEN}", MODE: "debug" },
      startupTimeoutMs: 5000,
      timeout: 30000,
    });
    expect(byPointer.get("/mcpServers/web")).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { "X-Api-Key": "${API_KEY}" },
    });
    expect(byPointer.get("/mcpServers/legacy")).toEqual({ type: "stdio", command: "srv" });

    // Imported hooks render back to the same settings.json entry.
    expect(byPointer.get("/hooks/PreToolUse")).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "/bin/sh -c npm run lint" }] },
    ]);

    const sections = ops.filter((op) => op.type === "managedMarkdownSection");
    expect(sections).toEqual([
      expect.objectContaining({
        path: path.join(tmp, "project", "CLAUDE.md"),
        sectionId: "style",
        content: "Use spaces.",
      }),
    ]);

    // Skill import is stable: importing the same directory twice hashes equally.
    const again = await adapter.import!(makeImportContext(tmp, "project"));
    expect(again.skills[0]!.contentHash).toBe(imported.skills[0]!.contentHash);
  });
});
