import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexAdapter } from "../src/index.js";
import {
  makeContext,
  makeInstallContext,
  makePack,
  makeSkill,
  makeStdioServer,
} from "./helpers.js";

const adapter = createCodexAdapter();

function fullPack(rootDir: string) {
  return makePack({
    rootDir,
    metadata: { name: "bundle-pack", version: "2.0.0", description: "A bundled pack" },
    skills: [makeSkill("review")],
    mcpServers: {
      github: makeStdioServer("github", {
        args: ["serve"],
        env: { TOKEN: { fromEnv: "GH_TOKEN" } },
      }),
      docs: {
        ...makeStdioServer("docs"),
        transport: "http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: { fromEnv: "DOCS_TOKEN" } },
      },
    },
    hooks: [{ id: "pre-check", event: "preToolUse", matcher: "bash", command: ["npm", "test"] }],
    plugin: {
      enabled: true,
      interface: { displayName: "Bundle Pack", categories: ["dev"] },
    },
    targetExtensions: { codex: { experimental: { flag: true } } },
  });
}

function writeOp(ops: { type: string; path?: string }[], suffix: string) {
  return ops.find(
    (op): op is { type: "writeFile"; path: string; content: string } =>
      op.type === "writeFile" && op.path !== undefined && op.path.endsWith(suffix),
  );
}

describe("plugin bundle", () => {
  let tmpDir: string;
  let packRoot: string;
  let bundleRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-codex-bundle-"));
    packRoot = path.join(tmpDir, "pack");
    bundleRoot = path.join(tmpDir, "bundle");
    await fs.mkdir(packRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function plan(packRootDir: string, withAssets: boolean) {
    if (withAssets) {
      await fs.mkdir(path.join(packRootDir, "assets"), { recursive: true });
      await fs.writeFile(path.join(packRootDir, "assets", "logo.txt"), "logo");
    }
    const artifacts = await adapter.generate(
      fullPack(packRootDir),
      makeContext({ options: { bundle: true } }),
    );
    return adapter.planInstall(artifacts, makeInstallContext({ bundleRoot }));
  }

  it("writes plugin.json with relative pointers and x-codex passthrough", async () => {
    const ops = await plan(packRoot, false);
    const op = writeOp(ops, path.join(".codex-plugin", "plugin.json"));
    expect(op).toBeDefined();
    expect(op!.path).toBe(path.join(bundleRoot, ".codex-plugin", "plugin.json"));
    const json = JSON.parse(op!.content) as Record<string, unknown>;
    expect(json).toEqual({
      name: "bundle-pack",
      version: "2.0.0",
      description: "A bundled pack",
      interface: { displayName: "Bundle Pack", categories: ["dev"] },
      skills: ["skills/review"],
      mcpServers: "./.mcp.json",
      hooks: "./hooks",
      "x-codex": { experimental: { flag: true } },
    });
  });

  it("writes an exact .mcp.json document (not a merge)", async () => {
    const ops = await plan(packRoot, false);
    const op = writeOp(ops, ".mcp.json");
    expect(op).toBeDefined();
    const expected = `${JSON.stringify(
      {
        mcpServers: {
          github: {
            type: "stdio",
            command: "run-server",
            args: ["serve"],
            env: { TOKEN: "${GH_TOKEN}" },
          },
          docs: {
            type: "http",
            url: "https://docs.example.com/mcp",
            headers: { Authorization: "${DOCS_TOKEN}" },
          },
        },
      },
      null,
      2,
    )}\n`;
    expect(op!.content).toBe(expected);
  });

  it("writes one hooks/<id>.json file per hook", async () => {
    const ops = await plan(packRoot, false);
    const op = writeOp(ops, path.join("hooks", "pre-check.json"));
    expect(op).toBeDefined();
    expect(op!.path).toBe(path.join(bundleRoot, "hooks", "pre-check.json"));
    expect(op!.content).toBe(
      `${JSON.stringify(
        { id: "pre-check", event: "preToolUse", matcher: "bash", command: ["npm", "test"] },
        null,
        2,
      )}\n`,
    );
  });

  it("always copies skills into the bundle", async () => {
    const ops = await plan(packRoot, false);
    const copy = ops.find(
      (op): op is { type: "copyDirectory"; source: string; dest: string } =>
        op.type === "copyDirectory" && op.dest.endsWith(path.join("skills", "review")),
    );
    expect(copy).toBeDefined();
    expect(copy!.dest).toBe(path.join(bundleRoot, "skills", "review"));
    expect(copy!.source).toBe(makeSkill("review").rootDir);
  });

  it("omits the assets pointer and copy op when the pack has no assets dir", async () => {
    const ops = await plan(packRoot, false);
    const plugin = writeOp(ops, path.join(".codex-plugin", "plugin.json"));
    expect(JSON.parse(plugin!.content)).not.toHaveProperty("assets");
    expect(
      ops.some((op) => op.type === "copyDirectory" && op.dest === path.join(bundleRoot, "assets")),
    ).toBe(false);
  });

  it("copies assets and keeps the pointer when the assets dir has files", async () => {
    const ops = await plan(packRoot, true);
    const plugin = writeOp(ops, path.join(".codex-plugin", "plugin.json"));
    expect(JSON.parse(plugin!.content)).toHaveProperty("assets", "./assets");
    expect(ops).toContainEqual({
      type: "copyDirectory",
      source: path.join(packRoot, "assets"),
      dest: path.join(bundleRoot, "assets"),
    });
  });

  it("omits .mcp.json and the plugin.json pointer when no servers are enabled", async () => {
    const pack = {
      ...fullPack(packRoot),
      mcpServers: { github: makeStdioServer("github", { enabled: false }) },
    };
    const artifacts = await adapter.generate(pack, makeContext({ options: { bundle: true } }));
    const ops = await adapter.planInstall(artifacts, makeInstallContext({ bundleRoot }));
    const plugin = writeOp(ops, path.join(".codex-plugin", "plugin.json"));
    expect(JSON.parse(plugin!.content)).not.toHaveProperty("mcpServers");
    expect(writeOp(ops, ".mcp.json")).toBeUndefined();
  });
});
