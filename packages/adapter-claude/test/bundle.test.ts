import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { CanonicalPack, InstallOperationLike } from "@agentpack/schema";

import { createClaudeAdapter } from "../src/index.js";
import {
  makeAdapterContext,
  makeInstallContext,
  makePack,
  makeSkillDir,
  makeTmpDir,
} from "./helpers.js";

async function bundlePack(packRoot: string): Promise<CanonicalPack> {
  const skillDir = await makeSkillDir(packRoot, "alpha");
  return makePack({
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
    mcpServers: {
      github: { name: "github", transport: "stdio", command: "npx", enabled: true },
    },
    hooks: [{ id: "lint", event: "preToolUse", matcher: "shell", command: ["npm", "run", "lint"] }],
    plugin: {
      enabled: true,
      interface: {
        author: "Acme Inc",
        displayName: "Test Pack",
        shortDescription: "Short blurb",
      },
    },
    targetExtensions: {
      claude: {
        agents: [{ name: "reviewer", description: "Reviews code", content: "Review the diff." }],
      },
    },
  });
}

function opPaths(ops: InstallOperationLike[]): string[] {
  return ops.map((op) => (op.type === "copyDirectory" ? op.dest : op.path)).sort();
}

describe("plugin bundle", () => {
  it("emits the full Claude plugin layout under bundleRoot", async () => {
    const tmp = await makeTmpDir();
    const packRoot = path.join(tmp, "pack");
    const bundleRoot = path.join(tmp, "bundle");
    const pack = await bundlePack(packRoot);
    await fs.mkdir(path.join(packRoot, "assets"), { recursive: true });
    await fs.writeFile(path.join(packRoot, "assets", "logo.txt"), "logo\n");

    const adapter = createClaudeAdapter();
    const artifacts = await adapter.generate(
      pack,
      makeAdapterContext(tmp, "project", { bundle: true }),
    );
    const ops = await adapter.planInstall(
      artifacts,
      makeInstallContext(tmp, "project", { bundleRoot }),
    );

    const writes = new Map(
      ops.filter((op) => op.type === "writeFile").map((op) => [op.path, op.content]),
    );

    const pluginJson = writes.get(path.join(bundleRoot, ".claude-plugin", "plugin.json"));
    expect(pluginJson).toBeDefined();
    expect(JSON.parse(pluginJson!)).toEqual({
      name: "test-pack",
      version: "1.0.0",
      description: "A test pack",
      author: "Acme Inc",
      displayName: "Test Pack",
      shortDescription: "Short blurb",
    });
    expect(pluginJson!.endsWith("\n")).toBe(true);

    expect(writes.get(path.join(bundleRoot, "agents", "reviewer.md"))).toBe(
      "---\nname: reviewer\ndescription: Reviews code\n---\n\nReview the diff.\n",
    );

    const hooksJson = writes.get(path.join(bundleRoot, "hooks", "hooks.json"));
    expect(JSON.parse(hooksJson!)).toEqual({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npm run lint" }] }],
      },
    });

    const mcpJson = writes.get(path.join(bundleRoot, ".mcp.json"));
    expect(JSON.parse(mcpJson!)).toEqual({
      mcpServers: { github: { type: "stdio", command: "npx" } },
    });

    const copies = ops.filter((op) => op.type === "copyDirectory");
    expect(copies.map((op) => op.dest).sort()).toEqual([
      path.join(bundleRoot, "assets"),
      path.join(bundleRoot, "skills", "alpha"),
    ]);
    // Bundles are self-contained: never symlinks.
    expect(ops.some((op) => op.type === "createSymlink")).toBe(false);
  });

  it("omits assets when the pack has no assets directory", async () => {
    const tmp = await makeTmpDir();
    const packRoot = path.join(tmp, "pack");
    const bundleRoot = path.join(tmp, "bundle");
    const pack = await bundlePack(packRoot);

    const adapter = createClaudeAdapter();
    const artifacts = await adapter.generate(
      pack,
      makeAdapterContext(tmp, "project", { bundle: true }),
    );
    const ops = await adapter.planInstall(
      artifacts,
      makeInstallContext(tmp, "project", { bundleRoot }),
    );

    expect(opPaths(ops)).not.toContain(path.join(bundleRoot, "assets"));
  });

  it("is deterministic across runs", async () => {
    const tmp = await makeTmpDir();
    const packRoot = path.join(tmp, "pack");
    const bundleRoot = path.join(tmp, "bundle");
    const pack = await bundlePack(packRoot);

    const adapter = createClaudeAdapter();
    const run = async () => {
      const artifacts = await adapter.generate(
        pack,
        makeAdapterContext(tmp, "project", { bundle: true }),
      );
      return adapter.planInstall(artifacts, makeInstallContext(tmp, "project", { bundleRoot }));
    };

    const [first, second] = await Promise.all([run(), run()]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
