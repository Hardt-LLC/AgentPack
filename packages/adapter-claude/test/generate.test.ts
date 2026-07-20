import path from "node:path";

import { describe, expect, it } from "vitest";
import type { CanonicalPack } from "@agentpack/schema";

import { createClaudeAdapter } from "../src/index.js";
import {
  makeAdapterContext,
  makeInstallContext,
  makePack,
  makeSkillDir,
  makeTmpDir,
} from "./helpers.js";

function mcpPack(): CanonicalPack {
  return makePack({
    mcpServers: {
      github: {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        enabled: true,
        env: {
          GITHUB_TOKEN: { fromEnv: "GH_TOKEN" },
          LOG_LEVEL: { value: "debug" },
          AUTH: { template: "Bearer ${GH_TOKEN}", requiredEnv: ["GH_TOKEN"] },
        },
        startupTimeoutMs: 5000,
        toolTimeoutMs: 30000,
      },
      docs: {
        name: "docs",
        transport: "http",
        url: "https://example.com/mcp",
        enabled: true,
        headers: { "X-Api-Key": { fromEnv: "API_KEY" } },
      },
    },
  });
}

describe("generate + planInstall: skills", () => {
  it("symlinks skills in symlink mode and copies in copy mode", async () => {
    const tmp = await makeTmpDir();
    const packRoot = path.join(tmp, "pack");
    const skillDir = await makeSkillDir(packRoot, "alpha");
    const adapter = createClaudeAdapter();
    const pack = makePack({
      rootDir: packRoot,
      skills: [
        {
          name: "alpha",
          description: "The alpha skill",
          rootDir: skillDir,
          files: ["SKILL.md"],
          frontmatter: { name: "alpha" },
        },
      ],
    });
    const context = makeAdapterContext(tmp, "project");
    const artifacts = await adapter.generate(pack, context);
    const dest = path.join(tmp, "project", ".claude", "skills", "alpha");

    const symlinkOps = await adapter.planInstall(
      artifacts,
      makeInstallContext(tmp, "project", { installMode: "symlink" }),
    );
    expect(symlinkOps).toEqual([{ type: "createSymlink", path: dest, target: skillDir }]);

    const copyOps = await adapter.planInstall(
      artifacts,
      makeInstallContext(tmp, "project", { installMode: "copy" }),
    );
    expect(copyOps).toEqual([{ type: "copyDirectory", source: skillDir, dest }]);

    const autoSymlink = await adapter.planInstall(
      artifacts,
      makeInstallContext(tmp, "project", { installMode: "auto", symlinksReliable: true }),
    );
    expect(autoSymlink).toEqual([{ type: "createSymlink", path: dest, target: skillDir }]);

    const autoCopy = await adapter.planInstall(
      artifacts,
      makeInstallContext(tmp, "project", { installMode: "auto", symlinksReliable: false }),
    );
    expect(autoCopy).toEqual([{ type: "copyDirectory", source: skillDir, dest }]);
  });

  it("installs skills under the user config root in user scope", async () => {
    const tmp = await makeTmpDir();
    const packRoot = path.join(tmp, "pack");
    const skillDir = await makeSkillDir(packRoot, "alpha");
    const adapter = createClaudeAdapter();
    const pack = makePack({
      rootDir: packRoot,
      skills: [
        {
          name: "alpha",
          description: "The alpha skill",
          rootDir: skillDir,
          files: ["SKILL.md"],
          frontmatter: { name: "alpha" },
        },
      ],
    });

    const artifacts = await adapter.generate(pack, makeAdapterContext(tmp, "user"));
    const ops = await adapter.planInstall(
      artifacts,
      makeInstallContext(tmp, "user", { installMode: "symlink" }),
    );

    expect(ops).toEqual([
      {
        type: "createSymlink",
        path: path.join(tmp, "home", ".claude", "skills", "alpha"),
        target: skillDir,
      },
    ]);
  });
});

describe("generate + planInstall: MCP servers", () => {
  it("emits json-merge artifacts for .mcp.json with exact values", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();
    const artifacts = await adapter.generate(mcpPack(), makeAdapterContext(tmp, "project"));
    const ops = await adapter.planInstall(artifacts, makeInstallContext(tmp, "project"));

    const mcpPath = path.join(tmp, "project", ".mcp.json");
    expect(ops).toEqual([
      {
        type: "mergeJson",
        path: mcpPath,
        pointer: "/mcpServers/github",
        value: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_TOKEN: "${GH_TOKEN}",
            LOG_LEVEL: "debug",
            AUTH: "Bearer ${GH_TOKEN}",
          },
          startupTimeoutMs: 5000,
          timeout: 30000,
        },
      },
      {
        type: "mergeJson",
        path: mcpPath,
        pointer: "/mcpServers/docs",
        value: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { "X-Api-Key": "${API_KEY}" },
        },
      },
    ]);
    // Deterministic key order inside the stdio value.
    const githubValue = (ops[0] as { value: Record<string, unknown> }).value;
    expect(Object.keys(githubValue)).toEqual([
      "type",
      "command",
      "args",
      "env",
      "startupTimeoutMs",
      "timeout",
    ]);
  });

  it("targets ~/.claude.json in user scope and skips disabled servers", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();
    const pack = mcpPack();
    pack.mcpServers.off = { name: "off", transport: "stdio", command: "off", enabled: false };

    const artifacts = await adapter.generate(pack, makeAdapterContext(tmp, "user"));
    const ops = await adapter.planInstall(artifacts, makeInstallContext(tmp, "user"));

    const mcpPath = path.join(tmp, "home", ".claude.json");
    expect(ops).toHaveLength(2);
    expect(ops.every((op) => op.type === "mergeJson" && op.path === mcpPath)).toBe(true);
  });
});

describe("generate + planInstall: hooks", () => {
  const hooksPack = (): CanonicalPack =>
    makePack({
      hooks: [
        { id: "lint", event: "preToolUse", matcher: "shell", command: ["npm", "run", "lint"] },
        { id: "read-guard", event: "preToolUse", matcher: "Read", command: ["guard"] },
        { id: "format", event: "postToolUse", matcher: "all", command: ["npm", "run", "format"] },
        { id: "kimi-only", event: "sessionStart", command: ["true"], targets: ["kimi"] },
      ],
    });

  it("groups hooks by Claude event into settings.json", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();
    const artifacts = await adapter.generate(hooksPack(), makeAdapterContext(tmp, "project"));
    const ops = await adapter.planInstall(artifacts, makeInstallContext(tmp, "project"));

    const settingsPath = path.join(tmp, "project", ".claude", "settings.json");
    expect(ops).toEqual([
      {
        type: "mergeJson",
        path: settingsPath,
        pointer: "/hooks/PreToolUse",
        value: [
          { matcher: "Bash", hooks: [{ type: "command", command: "npm run lint" }] },
          { matcher: "Read", hooks: [{ type: "command", command: "guard" }] },
        ],
      },
      {
        type: "mergeJson",
        path: settingsPath,
        pointer: "/hooks/PostToolUse",
        // "all" normalizes to an empty matcher: the field is omitted.
        value: [{ hooks: [{ type: "command", command: "npm run format" }] }],
      },
    ]);
  });

  it("uses ~/.claude/settings.json in user scope", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();
    const artifacts = await adapter.generate(hooksPack(), makeAdapterContext(tmp, "user"));
    const ops = await adapter.planInstall(artifacts, makeInstallContext(tmp, "user"));

    expect(ops.every((op) => op.type === "mergeJson")).toBe(true);
    const paths = ops.map((op) => (op.type === "mergeJson" ? op.path : ""));
    expect(paths).toEqual([
      path.join(tmp, "home", ".claude", "settings.json"),
      path.join(tmp, "home", ".claude", "settings.json"),
    ]);
  });
});

describe("generate + planInstall: instructions", () => {
  it("manages CLAUDE.md sections for project, directory and global scopes", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();
    const pack = makePack({
      instructions: [
        {
          id: "style",
          sourcePath: "/p/style.md",
          content: "Use spaces.",
          scope: "project",
          priority: 100,
          mergeStrategy: "managed-section",
        },
        {
          id: "web-rules",
          sourcePath: "/p/web.md",
          content: "Web rules.",
          scope: "directory",
          directory: "packages/web",
          priority: 100,
          mergeStrategy: "managed-section",
        },
        {
          id: "global-rules",
          sourcePath: "/p/global.md",
          content: "Global rules.",
          scope: "global",
          priority: 100,
          mergeStrategy: "managed-section",
        },
        {
          id: "changelog",
          sourcePath: "/p/changelog.md",
          content: "Appended note.",
          scope: "project",
          priority: 100,
          mergeStrategy: "append",
        },
        {
          id: "codex-only",
          sourcePath: "/p/codex.md",
          content: "Not for Claude.",
          scope: "project",
          priority: 100,
          mergeStrategy: "managed-section",
          targets: ["codex"],
        },
      ],
    });

    const artifacts = await adapter.generate(pack, makeAdapterContext(tmp, "project"));
    const ops = await adapter.planInstall(artifacts, makeInstallContext(tmp, "project"));

    expect(ops).toEqual([
      {
        type: "managedMarkdownSection",
        path: path.join(tmp, "project", "CLAUDE.md"),
        sectionId: "style",
        content: "Use spaces.",
        append: undefined,
      },
      {
        type: "managedMarkdownSection",
        path: path.join(tmp, "project", "packages", "web", "CLAUDE.md"),
        sectionId: "web-rules",
        content: "Web rules.",
        append: undefined,
      },
      {
        type: "managedMarkdownSection",
        path: path.join(tmp, "home", ".claude", "CLAUDE.md"),
        sectionId: "global-rules",
        content: "Global rules.",
        append: undefined,
      },
      {
        type: "managedMarkdownSection",
        path: path.join(tmp, "project", "CLAUDE.md"),
        sectionId: "changelog",
        content: "Appended note.",
        append: true,
      },
    ]);
  });
});
