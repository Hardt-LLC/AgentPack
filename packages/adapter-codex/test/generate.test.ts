import path from "node:path";

import { mergeTomlAtTable } from "@agentpack/filesystem";
import { describe, expect, it } from "vitest";

import { createCodexAdapter } from "../src/index.js";
import {
  HOME_DIR,
  makeContext,
  makeInstallContext,
  makeInstruction,
  makePack,
  makeSkill,
  makeStdioServer,
  PACK_ROOT,
  PROJECT_ROOT,
} from "./helpers.js";

const adapter = createCodexAdapter();

describe("generate + planInstall (sync)", () => {
  it("symlinks skills into <projectRoot>/.agents/skills in auto mode with reliable symlinks", async () => {
    const pack = makePack({ skills: [makeSkill("review")] });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(artifacts, makeInstallContext());
    expect(ops).toEqual([
      {
        type: "createSymlink",
        path: path.join(PROJECT_ROOT, ".agents", "skills", "review"),
        target: path.join(PACK_ROOT, "skills", "review"),
      },
    ]);
  });

  it("symlinks skills when installMode is symlink even without reliable symlinks", async () => {
    const pack = makePack({ skills: [makeSkill("review")] });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(
      artifacts,
      makeInstallContext({ installMode: "symlink", symlinksReliable: false }),
    );
    expect(ops[0]).toMatchObject({ type: "createSymlink" });
  });

  it("copies skills when installMode is copy", async () => {
    const pack = makePack({ skills: [makeSkill("review")] });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(artifacts, makeInstallContext({ installMode: "copy" }));
    expect(ops).toEqual([
      {
        type: "copyDirectory",
        source: path.join(PACK_ROOT, "skills", "review"),
        dest: path.join(PROJECT_ROOT, ".agents", "skills", "review"),
      },
    ]);
  });

  it("copies skills in auto mode when symlinks are unreliable", async () => {
    const pack = makePack({ skills: [makeSkill("review")] });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(
      artifacts,
      makeInstallContext({ installMode: "auto", symlinksReliable: false }),
    );
    expect(ops[0]).toMatchObject({ type: "copyDirectory" });
  });

  it("installs user-scope skills below <homeDir>/.agents/skills", async () => {
    const pack = makePack({ skills: [makeSkill("review")] });
    const artifacts = await adapter.generate(pack, makeContext({ scope: "user" }));
    const ops = await adapter.planInstall(artifacts, makeInstallContext({ scope: "user" }));
    expect(ops).toEqual([
      {
        type: "createSymlink",
        path: path.join(HOME_DIR, ".agents", "skills", "review"),
        target: path.join(PACK_ROOT, "skills", "review"),
      },
    ]);
  });

  it("merges MCP servers into the project config.toml for project scope", async () => {
    const pack = makePack({ mcpServers: { github: makeStdioServer("github") } });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(artifacts, makeInstallContext());
    expect(ops).toEqual([
      {
        type: "mergeToml",
        path: path.join(PROJECT_ROOT, ".codex", "config.toml"),
        table: ["mcp_servers", "github"],
        value: { command: "run-server" },
      },
    ]);
  });

  it("merges MCP servers into the user config.toml for user scope", async () => {
    const pack = makePack({ mcpServers: { github: makeStdioServer("github") } });
    const context = makeContext({ scope: "user" });
    const artifacts = await adapter.generate(pack, context);
    const ops = await adapter.planInstall(
      artifacts,
      makeInstallContext({ scope: "user", detection: context.detection }),
    );
    expect(ops).toEqual([
      {
        type: "mergeToml",
        path: path.join(HOME_DIR, ".codex", "config.toml"),
        table: ["mcp_servers", "github"],
        value: { command: "run-server" },
      },
    ]);
  });

  it("skips disabled servers in generate", async () => {
    const pack = makePack({
      mcpServers: { github: makeStdioServer("github", { enabled: false }) },
    });
    const artifacts = await adapter.generate(pack, makeContext());
    expect(artifacts).toEqual([]);
  });

  it("writes project instructions into <projectRoot>/AGENTS.md", async () => {
    const pack = makePack({ instructions: [makeInstruction()] });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(artifacts, makeInstallContext());
    expect(ops).toEqual([
      {
        type: "managedMarkdownSection",
        path: path.join(PROJECT_ROOT, "AGENTS.md"),
        sectionId: "rules",
        content: "Follow the rules.",
        append: false,
      },
    ]);
  });

  it("writes directory instructions into <projectRoot>/<directory>/AGENTS.md", async () => {
    const pack = makePack({
      instructions: [makeInstruction({ scope: "directory", directory: "docs/guide" })],
    });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(artifacts, makeInstallContext());
    expect(ops).toEqual([
      {
        type: "managedMarkdownSection",
        path: path.join(PROJECT_ROOT, "docs", "guide", "AGENTS.md"),
        sectionId: "rules",
        content: "Follow the rules.",
        append: false,
      },
    ]);
  });

  it("writes global instructions into <userConfigRoot>/AGENTS.md", async () => {
    const pack = makePack({ instructions: [makeInstruction({ scope: "global" })] });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(artifacts, makeInstallContext());
    expect(ops).toEqual([
      {
        type: "managedMarkdownSection",
        path: path.join(HOME_DIR, ".codex", "AGENTS.md"),
        sectionId: "rules",
        content: "Follow the rules.",
        append: false,
      },
    ]);
  });

  it("marks append mergeStrategy on the markdown operation", async () => {
    const pack = makePack({ instructions: [makeInstruction({ mergeStrategy: "append" })] });
    const artifacts = await adapter.generate(pack, makeContext());
    const ops = await adapter.planInstall(artifacts, makeInstallContext());
    expect(ops[0]).toMatchObject({ type: "managedMarkdownSection", append: true });
  });

  it("skips instructions whose targets do not include codex", async () => {
    const pack = makePack({
      instructions: [
        makeInstruction({ id: "claude-only", targets: ["claude"] }),
        makeInstruction({ id: "for-codex", targets: ["codex", "kimi"] }),
      ],
    });
    const artifacts = await adapter.generate(pack, makeContext());
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "markdown-section", sectionId: "for-codex" });
  });
});

describe("TOML rendering", () => {
  it("renders stdio env references, passEnv, timeouts and approval", async () => {
    const pack = makePack({
      mcpServers: {
        github: makeStdioServer("github", {
          args: ["mcp", "serve"],
          env: {
            GITHUB_TOKEN: { fromEnv: "GH_TOKEN" },
            MODE: { value: "fast" },
          },
          passEnv: ["PATH", "HOME"],
          startupTimeoutMs: 5000,
          toolTimeoutMs: 30000,
          approval: { default: "always" },
        }),
      },
    });
    const artifacts = await adapter.generate(pack, makeContext());
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0]!;
    expect(artifact).toMatchObject({ kind: "toml-merge", table: ["mcp_servers", "github"] });
    const value = artifact.kind === "toml-merge" ? artifact.value : undefined;
    expect(value).toEqual({
      command: "run-server",
      args: ["mcp", "serve"],
      env: { GITHUB_TOKEN: "${GH_TOKEN}", MODE: "fast" },
      env_vars: ["PATH", "HOME"],
      startup_timeout_ms: 5000,
      tool_timeout_ms: 30000,
      approval_policy: "always",
    });
  });

  it("renders http servers with http_headers", async () => {
    const pack = makePack({
      mcpServers: {
        docs: {
          ...makeStdioServer("docs"),
          transport: "http",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: { fromEnv: "DOCS_TOKEN" } },
          toolTimeoutMs: 10000,
        },
      },
    });
    const artifacts = await adapter.generate(pack, makeContext());
    const value = artifacts[0]!.kind === "toml-merge" ? artifacts[0]!.value : undefined;
    expect(value).toEqual({
      url: "https://docs.example.com/mcp",
      http_headers: { Authorization: "${DOCS_TOKEN}" },
      tool_timeout_ms: 10000,
    });
  });

  it("does not render allowTools or denyTools", async () => {
    const pack = makePack({
      mcpServers: {
        github: makeStdioServer("github", { allowTools: ["read"], denyTools: ["write"] }),
      },
    });
    const artifacts = await adapter.generate(pack, makeContext());
    const value = artifacts[0]!.kind === "toml-merge" ? artifacts[0]!.value : undefined;
    expect(value).toEqual({ command: "run-server" });
  });

  it("produces TOML with ${VAR} references through mergeTomlAtTable", async () => {
    const pack = makePack({
      mcpServers: {
        github: makeStdioServer("github", { env: { API_KEY: { fromEnv: "OPENAI_API_KEY" } } }),
      },
    });
    const artifacts = await adapter.generate(pack, makeContext());
    const artifact = artifacts[0]!;
    if (artifact.kind !== "toml-merge") throw new Error("expected toml-merge");
    const toml = mergeTomlAtTable(undefined, artifact.table, artifact.value);
    expect(toml).toContain("[mcp_servers.github]");
    expect(toml).toContain('API_KEY = "${OPENAI_API_KEY}"');
  });

  it("is deterministic across runs", async () => {
    const pack = makePack({
      skills: [makeSkill("review")],
      instructions: [makeInstruction()],
      mcpServers: {
        github: makeStdioServer("github", {
          args: ["serve"],
          env: { TOKEN: { fromEnv: "GH_TOKEN" } },
          passEnv: ["PATH"],
        }),
        docs: { ...makeStdioServer("docs"), transport: "http", url: "https://x.test/mcp" },
      },
    });
    const context = makeContext();
    const first = await adapter.generate(pack, context);
    const second = await adapter.generate(pack, context);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
