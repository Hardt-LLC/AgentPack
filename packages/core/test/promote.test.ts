import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import { loadState } from "@agentpack/filesystem";
import { parse as parseYaml } from "yaml";
import type { TargetAdapter } from "@agentpack/schema";
import { collectFromTarget, createRegistry, loadWorkspace, promotePack } from "../src/index.js";
import { createFakeAdapter, writeWorkspace } from "./helpers.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  tmp = await makeTempDir();
});
afterEach(async () => {
  await tmp.cleanup();
});

/** Workspace fixture whose only profiled pack has no executable components. */
const FILES: Record<string, string> = {
  "agentpack.yaml": `apiVersion: agentpack.dev/v1alpha1
kind: Workspace
packs:
  - path: ./packs/tools
profiles:
  default:
    packs: [tools]
    targets: [claude]
    scope: project
    installMode: auto
`,
  "packs/tools/pack.yaml": `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: tools
  version: 0.1.0
spec:
  skills:
    - path: ./skills/tools
  instructions: []
  mcpServers: {}
  hooks: []
`,
  "packs/tools/skills/tools/SKILL.md": `---
name: tools
description: test skill
---

# tools
`,
};

const STDIO = { transport: "stdio" as const, command: "node", enabled: true };

/** Fake claude adapter importing one natively-installed MCP server. */
function collectingAdapter(): TargetAdapter {
  const base = createFakeAdapter("claude");
  return {
    ...base,
    async import() {
      return {
        skills: [],
        mcpServers: { freshserver: STDIO },
        instructions: [],
        extensions: {},
        warnings: [],
      };
    },
  };
}

async function collectInbox(): Promise<void> {
  await collectFromTarget(
    await loadWorkspace(tmp.dir),
    createRegistry([collectingAdapter()]),
    "claude",
    {
      homeDir: tmp.dir,
    },
  );
}

describe("promotePack", () => {
  it("updates the profile, records trust and syncs the pack out", async () => {
    await writeWorkspace(tmp.dir, FILES);
    await collectInbox();

    const registry = createRegistry([createFakeAdapter("claude")]);
    const result = await promotePack(await loadWorkspace(tmp.dir), registry, "inbox-claude", {
      homeDir: tmp.dir,
    });

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.profileUpdated).toBe(true);
    expect(result.trustGranted).toBe(true);
    expect(result.synced).toBe(true);

    // Default profile now lists the inbox pack.
    const yaml = parseYaml(await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8")) as {
      profiles: { default: { packs: string[] } };
    };
    expect(yaml.profiles.default.packs).toContain("inbox-claude");

    // Trust recorded with the current content hash.
    const state = await loadState(tmp.dir);
    expect(state.trust?.["inbox-claude"]?.contentHash).toMatch(/^sha256:/);

    // Sync applied without --trust: the server landed in the target config.
    const mcp = JSON.parse(
      await fs.readFile(path.join(tmp.dir, ".claude", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toContain("freshserver");
  });

  it("is idempotent on the profile entry", async () => {
    await writeWorkspace(tmp.dir, FILES);
    await collectInbox();
    const registry = createRegistry([createFakeAdapter("claude")]);

    await promotePack(await loadWorkspace(tmp.dir), registry, "inbox-claude", {
      homeDir: tmp.dir,
    });
    const second = await promotePack(await loadWorkspace(tmp.dir), registry, "inbox-claude", {
      homeDir: tmp.dir,
    });
    expect(second.profileUpdated).toBe(false);
    expect(second.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const yaml = await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8");
    expect(yaml.match(/inbox-claude/g)).toHaveLength(2); // packs: entry + profile entry
  });

  it("dry-run reports but writes nothing", async () => {
    await writeWorkspace(tmp.dir, FILES);
    await collectInbox();
    const before = await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8");

    const result = await promotePack(
      await loadWorkspace(tmp.dir),
      createRegistry([createFakeAdapter("claude")]),
      "inbox-claude",
      { dryRun: true, homeDir: tmp.dir },
    );
    expect(result.synced).toBe(false);
    expect(result.profileUpdated).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("would add"))).toBe(true);
    expect(await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8")).toBe(before);
    const state = await loadState(tmp.dir);
    expect(state.trust?.["inbox-claude"]).toBeUndefined();
  });

  it("errors for an unknown pack", async () => {
    await writeWorkspace(tmp.dir, FILES);
    const result = await promotePack(
      await loadWorkspace(tmp.dir),
      createRegistry([createFakeAdapter("claude")]),
      "nope",
      { homeDir: tmp.dir },
    );
    expect(result.synced).toBe(false);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
    expect(result.diagnostics[0]!.message).toContain('pack "nope" not found');
  });

  it("errors when there is no default profile", async () => {
    await writeWorkspace(tmp.dir, {
      ...FILES,
      "agentpack.yaml": `apiVersion: agentpack.dev/v1alpha1
kind: Workspace
packs:
  - path: ./packs/tools
`,
    });
    const result = await promotePack(
      await loadWorkspace(tmp.dir),
      createRegistry([createFakeAdapter("claude")]),
      "tools",
      { homeDir: tmp.dir },
    );
    expect(result.synced).toBe(false);
    expect(result.diagnostics[0]!.message).toContain('no "default" profile');
  });
});
