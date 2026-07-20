import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, writeTree } from "@agentpack/testing";
import { loadState } from "@agentpack/filesystem";
import {
  adoptDuplicateMcpServers,
  createRegistry,
  loadWorkspace,
  setupGateway,
  syncWorkspace,
  uninstallWorkspace,
} from "../src/index.js";
import { createFakeAdapter, writeWorkspace } from "./helpers.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
let home: { dir: string; cleanup: () => Promise<void> };

beforeEach(async () => {
  tmp = await makeTempDir();
  home = await makeTempDir("agentpack-home-");
});
afterEach(async () => {
  await tmp.cleanup();
  await home.cleanup();
});

const registry = () => createRegistry([createFakeAdapter("claude")]);
const mcpPath = () => path.join(tmp.dir, ".claude", "mcp.json");
const readMcp = async () => JSON.parse(await fs.readFile(mcpPath(), "utf8"));

describe("adoption", () => {
  it("adopts duplicate unmanaged MCP keys and keeps the rest", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify(
        {
          mcpServers: {
            local: { command: "original-local", keep: "me" },
            other: { command: "untouched" },
          },
          unrelated: true,
        },
        null,
        2,
      ),
    });
    const ws = await loadWorkspace(tmp.dir);
    const result = await adoptDuplicateMcpServers(ws, registry(), ["local"], {
      homeDir: home.dir,
      env: {},
    });
    expect(result.adopted).toHaveLength(1);
    expect(result.adopted[0]?.key).toBe("/mcpServers/local");

    const mcp = await readMcp();
    expect(mcp.mcpServers.local).toBeUndefined();
    expect(mcp.mcpServers.other.command).toBe("untouched");
    expect(mcp.unrelated).toBe(true);

    const state = await loadState(tmp.dir);
    const adopted = state.targets["claude"]?.adopted;
    expect(adopted?.configKeys).toHaveLength(1);
    expect((adopted?.configKeys[0]?.value as { keep: string }).keep).toBe("me");
  });

  it("adopts unmanaged skill dirs during sync --adopt and records them", async () => {
    await writeWorkspace(tmp.dir);
    // Pre-existing UNMANAGED real directory where the skill symlink will go.
    await writeTree(tmp.dir, {
      ".claude/skills/tools/SKILL.md": "---\nname: tools\ndescription: old local copy\n---\n",
    });
    const ws = await loadWorkspace(tmp.dir);

    const result = await syncWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
      adopt: true,
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.adoptions).toHaveLength(1);
    expect(result.adoptions?.[0]?.path).toBe(path.join(tmp.dir, ".claude", "skills", "tools"));

    const link = path.join(tmp.dir, ".claude", "skills", "tools");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);

    const state = await loadState(tmp.dir);
    const adoptedPaths = state.targets["claude"]?.adopted?.paths ?? [];
    expect(adoptedPaths).toHaveLength(1);
    expect(adoptedPaths[0]?.type).toBe("directory");
  });

  it("uninstall removes owned items and restores adopted keys and paths", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify({
        mcpServers: { local: { command: "original-local" }, other: { command: "keep" } },
      }),
      ".claude/skills/tools/SKILL.md": "---\nname: tools\ndescription: old local copy\n---\n",
    });
    const ws = await loadWorkspace(tmp.dir);

    // Full onboarding: adopt MCP key, sync with path adoption, gateway setup.
    await adoptDuplicateMcpServers(ws, registry(), ["local"], { homeDir: home.dir, env: {} });
    await syncWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
      adopt: true,
    });
    await setupGateway(ws, registry(), { homeDir: home.dir, env: {}, cliPath: "/x/cli.mjs" });

    // Sanity: gateway entry present, original directory replaced by symlink.
    expect((await readMcp()).mcpServers.agentpack).toBeDefined();
    expect(
      (await fs.lstat(path.join(tmp.dir, ".claude", "skills", "tools"))).isSymbolicLink(),
    ).toBe(true);

    const result = await uninstallWorkspace(ws, registry(), { homeDir: home.dir, env: {} });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    // Owned items are gone (the skill path is now the restored ORIGINAL dir, verified below).
    const midState = await loadState(tmp.dir);
    expect(midState.targets["claude"]?.ownedFiles).toHaveLength(0);
    // Adopted MCP key restored with its exact value; unmanaged key untouched.
    const mcp = await readMcp();
    expect(mcp.mcpServers.local.command).toBe("original-local");
    expect(mcp.mcpServers.other.command).toBe("keep");
    expect(mcp.mcpServers.agentpack).toBeUndefined();
    // Adopted directory restored with original content.
    const restored = await fs.readFile(
      path.join(tmp.dir, ".claude", "skills", "tools", "SKILL.md"),
      "utf8",
    );
    expect(restored).toContain("old local copy");
    expect(
      (await fs.lstat(path.join(tmp.dir, ".claude", "skills", "tools"))).isSymbolicLink(),
    ).toBe(false);

    // State no longer records the restored adoptions.
    const state = await loadState(tmp.dir);
    expect(state.targets["claude"]?.adopted?.configKeys).toHaveLength(0);
    expect(state.targets["claude"]?.adopted?.paths).toHaveLength(0);
  });

  it("adoption backups contain the PRE-adoption file content", async () => {
    await writeWorkspace(tmp.dir);
    const original = JSON.stringify({ mcpServers: { local: { command: "original-local" } } });
    await writeTree(tmp.dir, { ".claude/mcp.json": original });
    const ws = await loadWorkspace(tmp.dir);
    const result = await adoptDuplicateMcpServers(ws, registry(), ["local"], {
      homeDir: home.dir,
      env: {},
    });
    expect(result.backupId).toBeDefined();
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(tmp.dir, ".agentpack", "backups", result.backupId!, "manifest.json"),
        "utf8",
      ),
    );
    const stored = await fs.readFile(
      path.join(tmp.dir, ".agentpack", "backups", result.backupId!, manifest.entries[0].storedPath),
      "utf8",
    );
    expect(stored).toBe(original);
  });

  it("setupGateway --adopt keeps adopted keys recorded in state (no stale-state wipe)", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify({ mcpServers: { local: { command: "orig" } } }),
    });
    const ws = await loadWorkspace(tmp.dir);
    const result = await setupGateway(ws, registry(), {
      homeDir: home.dir,
      env: {},
      cliPath: "/x/cli.mjs",
      adopt: true,
    });
    expect(result.adoptedKeys).toHaveLength(1);
    const state = await loadState(tmp.dir);
    const adopted = state.targets["claude"]?.adopted?.configKeys ?? [];
    expect(adopted).toHaveLength(1);
    expect((adopted[0]?.value as { command: string }).command).toBe("orig");
    // And the file has only the gateway entry.
    expect(Object.keys((await readMcp()).mcpServers)).toEqual(["agentpack"]);
  });

  it("uninstall never overwrites a foreign same-name key when restoring", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify({ mcpServers: { local: { command: "orig" } } }),
    });
    const ws = await loadWorkspace(tmp.dir);
    await adoptDuplicateMcpServers(ws, registry(), ["local"], { homeDir: home.dir, env: {} });
    // User hand-recreates a DIFFERENT entry under the adopted name.
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify({ mcpServers: { local: { command: "hand-written" } } }),
    });
    const result = await uninstallWorkspace(ws, registry(), { homeDir: home.dir, env: {} });
    expect(result.restoredKeys).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason.includes("left in place"))).toBe(true);
    expect((await readMcp()).mcpServers.local.command).toBe("hand-written");
  });

  it("uninstall --dry-run changes nothing", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify({ mcpServers: { local: { command: "orig" } } }),
    });
    const ws = await loadWorkspace(tmp.dir);
    await adoptDuplicateMcpServers(ws, registry(), ["local"], { homeDir: home.dir, env: {} });
    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });

    const before = await fs.readFile(mcpPath(), "utf8");
    const result = await uninstallWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.restoredKeys.length).toBeGreaterThan(0);
    expect(await fs.readFile(mcpPath(), "utf8")).toBe(before);
  });
});
