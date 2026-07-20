import path from "node:path";

import type {
  CanonicalHook,
  CanonicalInstruction,
  CanonicalMcpServer,
  CanonicalSkill,
} from "@agentpack/schema";
import { describe, expect, it } from "vitest";

import { generateKimi } from "../src/generate.js";
import { planKimiInstall } from "../src/plan.js";
import { makeContext, makeInstallContext, makePack, makeTmpDir } from "./helpers.js";

const skill: CanonicalSkill = {
  name: "review",
  description: "Review code",
  rootDir: "/packs/test/skills/review",
  files: ["SKILL.md"],
  frontmatter: { name: "review" },
};

const stdioServer: CanonicalMcpServer = {
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" }, LOG_LEVEL: { value: "debug" } },
  passEnv: ["HOME", "PATH"],
  approval: { default: "always" },
  allowTools: ["get_issue", "list_prs"],
  denyTools: ["delete_repo"],
  startupTimeoutMs: 5000,
  enabled: true,
};

const sseServer: CanonicalMcpServer = {
  name: "docs",
  transport: "sse",
  url: "https://example.com/sse",
  headers: { Authorization: { template: "Bearer ${API_TOKEN}", requiredEnv: ["API_TOKEN"] } },
  toolTimeoutMs: 30000,
  enabled: true,
};

const hook: CanonicalHook = {
  id: "lint",
  event: "preToolUse",
  matcher: "shell",
  command: ["pnpm", "lint"],
};

const instruction: CanonicalInstruction = {
  id: "coding-style",
  sourcePath: "/packs/test/instructions/coding-style.md",
  content: "Use strict TypeScript.",
  scope: "project",
  priority: 100,
  mergeStrategy: "managed-section",
};

function fullPack(tmp: string) {
  return makePack(path.join(tmp, "pack"), {
    skills: [skill],
    mcpServers: { github: stdioServer, docs: sseServer },
    hooks: [hook],
    instructions: [instruction],
  });
}

describe("generate + planInstall", () => {
  it("emits exact mcp.json merge values with deterministic key order", async () => {
    const tmp = await makeTmpDir();
    const artifacts = await generateKimi(fullPack(tmp), makeContext(tmp));
    const merges = artifacts.filter((a) => a.kind === "json-merge" && a.relPath === "mcp.json");
    expect(merges.map((m) => (m.kind === "json-merge" ? m.pointer : ""))).toEqual([
      "/mcpServers/github",
      "/mcpServers/docs",
    ]);

    const github = merges[0];
    if (github?.kind !== "json-merge") throw new Error("expected json-merge");
    expect(github.value).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "debug" },
      passEnv: ["HOME", "PATH"],
      startupTimeoutMs: 5000,
      approval: { default: "always" },
      allowTools: ["get_issue", "list_prs"],
      denyTools: ["delete_repo"],
    });
    expect(Object.keys(github.value as Record<string, unknown>)).toEqual([
      "type",
      "command",
      "args",
      "env",
      "passEnv",
      "startupTimeoutMs",
      "approval",
      "allowTools",
      "denyTools",
    ]);

    const docs = merges[1];
    if (docs?.kind !== "json-merge") throw new Error("expected json-merge");
    expect(docs.value).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer ${API_TOKEN}" },
      toolTimeoutMs: 30000,
    });
  });

  it("routes mcp.json to .kimi-code under both strategies and scopes", async () => {
    const tmp = await makeTmpDir();
    const artifacts = await generateKimi(fullPack(tmp), makeContext(tmp));
    const projectOps = await planKimiInstall(artifacts, makeInstallContext(tmp));
    const projectMerge = projectOps.find((o) => o.type === "mergeJson");
    if (projectMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(projectMerge.path).toBe(path.join(tmp, "project", ".kimi-code", "mcp.json"));

    const userOps = await planKimiInstall(
      await generateKimi(fullPack(tmp), makeContext(tmp, { scope: "user" })),
      makeInstallContext(tmp, { scope: "user" }),
    );
    const userMerge = userOps.find((o) => o.type === "mergeJson");
    if (userMerge?.type !== "mergeJson") throw new Error("expected mergeJson");
    expect(userMerge.path).toBe(path.join(tmp, "home", ".kimi-code", "mcp.json"));
  });

  it("emits AGENTS.md managed sections with the instruction id", async () => {
    const tmp = await makeTmpDir();
    const artifacts = await generateKimi(fullPack(tmp), makeContext(tmp));
    const section = artifacts.find((a) => a.kind === "markdown-section");
    expect(section).toMatchObject({
      kind: "markdown-section",
      root: "projectConfig",
      relPath: "AGENTS.md",
      sectionId: "coding-style",
      content: "Use strict TypeScript.",
    });
  });

  it("emits hooks.json merges grouped by event and drops notification", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      hooks: [
        hook,
        { id: "fmt", event: "preToolUse", matcher: "all", command: ["pnpm", "format"] },
        { id: "notify", event: "notification", command: ["say", "done"] },
      ],
    });
    const artifacts = await generateKimi(pack, makeContext(tmp));
    const hookMerges = artifacts.filter(
      (a) => a.kind === "json-merge" && a.relPath === "hooks.json",
    );
    expect(hookMerges).toHaveLength(1);
    const merge = hookMerges[0];
    if (merge?.kind !== "json-merge") throw new Error("expected json-merge");
    expect(merge.pointer).toBe("/hooks/preToolUse");
    expect(merge.value).toEqual([
      { id: "lint", matcher: "shell", command: ["pnpm", "lint"] },
      { id: "fmt", command: ["pnpm", "format"] },
    ]);
  });

  it("skips disabled servers and non-kimi instructions", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      mcpServers: {
        off: { name: "off", transport: "stdio", command: "x", enabled: false },
      },
      instructions: [{ ...instruction, id: "claude-only", targets: ["claude"] }],
    });
    const artifacts = await generateKimi(pack, makeContext(tmp));
    expect(artifacts).toEqual([]);
  });

  it("symlinks skills in symlink mode and auto mode with reliable symlinks", async () => {
    const tmp = await makeTmpDir();
    const artifacts = await generateKimi(fullPack(tmp), makeContext(tmp));

    for (const context of [
      makeInstallContext(tmp, { installMode: "symlink", symlinksReliable: false }),
      makeInstallContext(tmp, { installMode: "auto", symlinksReliable: true }),
    ]) {
      const ops = await planKimiInstall(artifacts, context);
      const link = ops.find((o) => o.type === "createSymlink");
      if (link?.type !== "createSymlink") throw new Error("expected createSymlink");
      expect(link.path).toBe(path.join(tmp, "project", ".agents", "skills", "review"));
      expect(link.target).toBe("/packs/test/skills/review");
      expect(ops.some((o) => o.type === "copyDirectory")).toBe(false);
    }
  });

  it("copies skills in copy mode and auto mode without reliable symlinks", async () => {
    const tmp = await makeTmpDir();
    const artifacts = await generateKimi(fullPack(tmp), makeContext(tmp));

    for (const context of [
      makeInstallContext(tmp, { installMode: "copy" }),
      makeInstallContext(tmp, { installMode: "auto", symlinksReliable: false }),
    ]) {
      const ops = await planKimiInstall(artifacts, context);
      const copy = ops.find((o) => o.type === "copyDirectory");
      if (copy?.type !== "copyDirectory") throw new Error("expected copyDirectory");
      expect(copy.source).toBe("/packs/test/skills/review");
      expect(copy.dest).toBe(path.join(tmp, "project", ".agents", "skills", "review"));
      expect(ops.some((o) => o.type === "createSymlink")).toBe(false);
    }
  });
});
