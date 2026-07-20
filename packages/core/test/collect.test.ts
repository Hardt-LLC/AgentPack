import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import { emptyState, hashDirectory, saveState } from "@agentpack/filesystem";
import type { CanonicalMcpServer, TargetAdapter } from "@agentpack/schema";
import {
  collectFromTarget,
  createRegistry,
  loadWorkspace,
  parsePackManifest,
  watchWorkspace,
  type WatchEvent,
} from "../src/index.js";
import { createFakeAdapter, writeWorkspace } from "./helpers.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  tmp = await makeTempDir();
});
afterEach(async () => {
  await tmp.cleanup();
});

type FakeServer = Omit<CanonicalMcpServer, "name">;

interface FakeImport {
  skills?: Array<{
    name: string;
    description: string;
    files: Record<string, string>;
    contentHash: string;
  }>;
  mcpServers?: Record<string, FakeServer>;
}

/** Fake claude adapter with an import() and nativeSources() for collect tests. */
function collectingAdapter(config: FakeImport, nativeFile?: string): TargetAdapter {
  const base = createFakeAdapter("claude");
  return {
    ...base,
    async import() {
      return {
        skills: config.skills ?? [],
        mcpServers: config.mcpServers ?? {},
        instructions: [],
        extensions: {},
        warnings: [],
      };
    },
    async nativeSources(context) {
      return [nativeFile ?? path.join(context.homeDir, ".fake", "mcp.json")];
    },
  };
}

const STDIO: FakeServer = { transport: "stdio", command: "node", enabled: true };

async function readInboxManifest(root: string) {
  const raw = await fs.readFile(path.join(root, "packs", "inbox-claude", "pack.yaml"), "utf8");
  const parsed = parsePackManifest(raw, "inbox pack");
  expect(parsed.manifest).toBeDefined();
  return parsed.manifest!;
}

describe("collectFromTarget", () => {
  it("collects new servers/skills and skips canonical, adopted and gateway entries", async () => {
    await writeWorkspace(tmp.dir);
    let ws = await loadWorkspace(tmp.dir);

    // Adopted server: recorded in state.json as deliberately taken over.
    const state = emptyState(ws.workspaceId);
    state.targets.claude = {
      ownedFiles: [],
      ownedConfigKeys: [],
      adopted: {
        configKeys: [
          {
            path: "/home/x/.claude.json",
            jsonPointer: "/mcpServers/oldserver",
            value: { type: "stdio", command: "node" },
            checksum: "sha256:x",
          },
        ],
        paths: [],
      },
    };
    await saveState(tmp.dir, state);

    // Skill that is byte-identical to the canonical "tools" skill.
    const toolsSkillDir = ws.packs[0]!.pack!.skills[0]!.rootDir;
    const toolsHash = await hashDirectory(toolsSkillDir);

    const adapter = collectingAdapter({
      mcpServers: {
        local: STDIO, // canonical in packs/tools
        oldserver: STDIO, // adopted
        agentpack: STDIO, // gateway entry name
        freshserver: STDIO, // genuinely new
      },
      skills: [
        {
          name: "dup-skill",
          description: "same as tools",
          files: { "SKILL.md": "x" },
          contentHash: toolsHash,
        },
        {
          name: "fresh-skill",
          description: "new",
          files: { "SKILL.md": "---\nname: fresh-skill\ndescription: new\n---\n" },
          contentHash: "sha256:fresh",
        },
      ],
    });

    const result = await collectFromTarget(ws, createRegistry([adapter]), "claude", {
      homeDir: tmp.dir,
    });

    expect(result.changed).toBe(true);
    expect(result.newServers).toEqual(["freshserver"]);
    const skipped = new Map(result.skippedServers.map((s) => [s.name, s.reason]));
    expect(skipped.get("local")).toBe("already canonical");
    expect(skipped.get("oldserver")).toBe("adopted");
    expect(skipped.get("agentpack")).toBe("gateway entry");
    expect(result.newSkills).toEqual(["fresh-skill"]);
    expect(result.duplicateSkills).toEqual(["dup-skill"]);

    // Inbox pack merged correctly.
    const manifest = await readInboxManifest(tmp.dir);
    expect(manifest.metadata.name).toBe("inbox-claude");
    expect(Object.keys(manifest.spec.mcpServers)).toEqual(["freshserver"]);
    expect(manifest.spec.skills).toEqual([{ path: "./skills/fresh-skill" }]);
    await fs.stat(path.join(tmp.dir, "packs", "inbox-claude", "skills", "fresh-skill", "SKILL.md"));

    // agentpack.yaml references the inbox pack but profiles are untouched.
    const yaml = await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8");
    expect(yaml).toContain("  - path: ./packs/inbox-claude");
    ws = await loadWorkspace(tmp.dir);
    expect(ws.manifest?.profiles["default"]?.packs).toEqual(["tools"]);
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("second collect is a no-op and agentpack.yaml gets the entry exactly once", async () => {
    await writeWorkspace(tmp.dir);
    const adapter = collectingAdapter({
      mcpServers: { freshserver: STDIO },
      skills: [
        {
          name: "fresh-skill",
          description: "new",
          files: { "SKILL.md": "---\nname: fresh-skill\ndescription: new\n---\n" },
          contentHash: "sha256:fresh",
        },
      ],
    });
    const registry = createRegistry([adapter]);

    const first = await collectFromTarget(await loadWorkspace(tmp.dir), registry, "claude", {
      homeDir: tmp.dir,
    });
    expect(first.changed).toBe(true);

    const second = await collectFromTarget(await loadWorkspace(tmp.dir), registry, "claude", {
      homeDir: tmp.dir,
    });
    expect(second.changed).toBe(false);
    expect(second.newServers).toEqual([]);
    expect(second.newSkills).toEqual([]);
    expect(second.skippedServers).toEqual([{ name: "freshserver", reason: "already canonical" }]);
    expect(second.duplicateSkills).toEqual(["fresh-skill"]);

    const yaml = await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8");
    expect(yaml.match(/\.\/packs\/inbox-claude/g)).toHaveLength(1);

    // Existing inbox entries survive a merge with another new server.
    const adapter2 = collectingAdapter({
      mcpServers: { freshserver: STDIO, another: STDIO },
    });
    const third = await collectFromTarget(
      await loadWorkspace(tmp.dir),
      createRegistry([adapter2]),
      "claude",
      { homeDir: tmp.dir },
    );
    expect(third.newServers).toEqual(["another"]);
    const manifest = await readInboxManifest(tmp.dir);
    expect(Object.keys(manifest.spec.mcpServers).sort()).toEqual(["another", "freshserver"]);
  });

  it("dry-run reports but writes nothing", async () => {
    await writeWorkspace(tmp.dir);
    const before = await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8");
    const result = await collectFromTarget(
      await loadWorkspace(tmp.dir),
      createRegistry([collectingAdapter({ mcpServers: { freshserver: STDIO } })]),
      "claude",
      { dryRun: true, homeDir: tmp.dir },
    );
    expect(result.changed).toBe(true);
    expect(result.newServers).toEqual(["freshserver"]);
    await expect(fs.stat(path.join(tmp.dir, "packs", "inbox-claude"))).rejects.toThrow();
    expect(await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8")).toBe(before);
  });

  it("errors when the adapter has no importer", async () => {
    await writeWorkspace(tmp.dir);
    const result = await collectFromTarget(
      await loadWorkspace(tmp.dir),
      createRegistry([createFakeAdapter("claude")]),
      "claude",
      { homeDir: tmp.dir },
    );
    expect(result.changed).toBe(false);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("converts literal secret values to fromEnv references", async () => {
    await writeWorkspace(tmp.dir);
    const adapter = collectingAdapter({
      mcpServers: {
        freshserver: {
          transport: "stdio",
          command: "node",
          enabled: true,
          env: { "api-key": { value: "sk-abcdefghijklmnop123456" } },
        },
      },
    });
    const result = await collectFromTarget(
      await loadWorkspace(tmp.dir),
      createRegistry([adapter]),
      "claude",
      { homeDir: tmp.dir },
    );
    expect(result.newServers).toEqual(["freshserver"]);
    const manifest = await readInboxManifest(tmp.dir);
    expect(manifest.spec.mcpServers["freshserver"]?.env).toEqual({
      "api-key": { fromEnv: "API_KEY" },
    });
    const raw = await fs.readFile(path.join(tmp.dir, "packs", "inbox-claude", "pack.yaml"), "utf8");
    expect(raw).not.toContain("sk-abcdefghijklmnop123456");
    expect(
      result.diagnostics.some((d) => d.severity === "info" && d.message.includes("fromEnv")),
    ).toBe(true);
  });
});

describe("watchWorkspace collect mode", () => {
  async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("fires a collected event after a native file change", async () => {
    await writeWorkspace(tmp.dir);
    const nativeDir = path.join(tmp.dir, "native");
    await fs.mkdir(nativeDir, { recursive: true });
    const nativeFile = path.join(nativeDir, "mcp.json");
    await fs.writeFile(nativeFile, JSON.stringify({ mcpServers: {} }));

    // Fake adapter whose import() reflects the fake native mcp.json file.
    const base = createFakeAdapter("claude");
    const adapter: TargetAdapter = {
      ...base,
      async import() {
        const raw = await fs.readFile(nativeFile, "utf8").catch(() => "{}");
        const doc = JSON.parse(raw) as { mcpServers?: Record<string, FakeServer> };
        return {
          skills: [],
          mcpServers: doc.mcpServers ?? {},
          instructions: [],
          extensions: {},
          warnings: [],
        };
      },
      async nativeSources() {
        return [nativeFile];
      },
    };

    const events: WatchEvent[] = [];
    const abort = new AbortController();
    const done = watchWorkspace(tmp.dir, createRegistry([adapter]), {
      collect: true,
      debounceMs: 100,
      homeDir: tmp.dir,
      env: {},
      trust: ["tools"],
      onEvent: (event) => {
        events.push(event);
      },
      signal: abort.signal,
    });

    await waitFor(() => events.some((e) => e.type === "synced"));
    await fs.writeFile(nativeFile, JSON.stringify({ mcpServers: { plugserver: STDIO } }));
    await waitFor(() => events.some((e) => e.type === "collected"));
    abort.abort();
    await done;

    const collected = events.find((e) => e.type === "collected");
    expect(collected?.message).toContain("collected 1 new item(s) from claude");
    expect(collected?.message).toContain("packs/inbox-claude");
    const manifest = await readInboxManifest(tmp.dir);
    expect(Object.keys(manifest.spec.mcpServers)).toEqual(["plugserver"]);
  }, 20000);
});
