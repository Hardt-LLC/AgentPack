import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import { loadState } from "@agentpack/filesystem";
import {
  buildPlan,
  createRegistry,
  detectTargets,
  gatewayConfigPath,
  generateGatewayConfig,
  loadWorkspace,
  setupGateway,
  syncWorkspace,
  syntheticGatewayPack,
  uninstallGateway,
  watchWorkspace,
  type WatchEvent,
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

describe("generateGatewayConfig", () => {
  it("collects enabled servers, dedupes identical, renders env refs", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const config = generateGatewayConfig(
      ws.packs.map((p) => p.pack!),
      { command: "node", args: ["cli.mjs", "gateway", "run"] },
    );
    expect(config.version).toBe(1);
    expect(Object.keys(config.servers)).toEqual(["local"]);
    expect(config.servers["local"]?.transport).toBe("stdio");
    expect(config.servers["local"]?.command).toBe("node");
  });
});

describe("setupGateway", () => {
  it("replaces individually synced MCP keys with one gateway entry", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    // First sync individual servers the classic way.
    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });
    expect((await readMcp()).mcpServers.local).toBeDefined();

    const result = await setupGateway(ws, registry(), {
      homeDir: home.dir,
      env: {},
      cliPath: "/opt/agentpack/cli.mjs",
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(result.serverCount).toBe(1);
    expect(result.reclaimedKeys).toHaveLength(1);
    expect(result.reclaimedKeys[0]?.key).toBe("/mcpServers/local");

    const mcp = await readMcp();
    expect(Object.keys(mcp.mcpServers)).toEqual(["agentpack"]);
    expect(mcp.mcpServers.agentpack.args).toEqual([
      "/opt/agentpack/cli.mjs",
      "gateway",
      "run",
      "--config",
      gatewayConfigPath(tmp.dir),
    ]);

    // gateway.json written deterministically with the launcher recorded.
    const gatewayJson = JSON.parse(await fs.readFile(gatewayConfigPath(tmp.dir), "utf8"));
    expect(gatewayJson.servers.local.command).toBe("node");
    expect(gatewayJson.launcher.command).toBe("node");

    // State tracks only the gateway key now.
    const state = await loadState(tmp.dir);
    const keys = state.targets["claude"]!.ownedConfigKeys;
    expect(keys.some((k) => k.jsonPointer === "/mcpServers/agentpack")).toBe(true);
    expect(keys.some((k) => k.jsonPointer === "/mcpServers/local")).toBe(false);
  });

  it("gateway mode in plan skips individual servers and injects the entry", async () => {
    await writeWorkspace(tmp.dir);
    // Enable gateway mode in the manifest.
    const manifestPath = path.join(tmp.dir, "agentpack.yaml");
    await fs.writeFile(
      manifestPath,
      (await fs.readFile(manifestPath, "utf8")) + "gateway:\n  enabled: true\n",
    );
    let ws = await loadWorkspace(tmp.dir);
    await setupGateway(ws, registry(), { homeDir: home.dir, env: {}, cliPath: "/x/cli.mjs" });
    ws = await loadWorkspace(tmp.dir);

    const plan = await buildPlan(
      ws,
      registry(),
      await detectTargets(registry(), tmp.dir, {
        homeDir: home.dir,
        env: {},
      }),
      { homeDir: home.dir, env: {} },
    );

    const ops = plan.targets[0]!.operations.map((p) => p.operation);
    const mcpOps = ops.filter((o) => o.type === "mergeJson");
    expect(mcpOps).toHaveLength(1);
    expect(mcpOps[0]).toMatchObject({ pointer: "/mcpServers/agentpack" });
    // Skills and instructions still flow through.
    expect(ops.some((o) => o.type === "createSymlink" || o.type === "copyDirectory")).toBe(true);
    expect(ops.some((o) => o.type === "managedMarkdownSection")).toBe(true);
  });

  it("uninstallGateway removes the entry and sync restores individual servers", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });
    await setupGateway(ws, registry(), { homeDir: home.dir, env: {}, cliPath: "/x/cli.mjs" });
    expect(Object.keys((await readMcp()).mcpServers)).toEqual(["agentpack"]);

    const result = await uninstallGateway(ws, registry(), { homeDir: home.dir, env: {} });
    expect(result.removed).toHaveLength(1);
    expect((await readMcp()).mcpServers?.agentpack).toBeUndefined();

    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });
    expect((await readMcp()).mcpServers.local).toBeDefined();
  });

  it("syntheticGatewayPack produces a stdio server entry", () => {
    const pack = syntheticGatewayPack("agentpack", { command: "node", args: ["a", "b"] });
    expect(pack.mcpServers["agentpack"]?.transport).toBe("stdio");
    expect(pack.mcpServers["agentpack"]?.args).toEqual(["a", "b"]);
  });
});

describe("watchWorkspace", () => {
  it("re-syncs when a canonical file changes", async () => {
    await writeWorkspace(tmp.dir);
    const events: WatchEvent[] = [];
    const abort = new AbortController();
    const watchDone = watchWorkspace(tmp.dir, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
      debounceMs: 100,
      signal: abort.signal,
      onEvent: (e) => {
        events.push(e);
      },
    });

    // Wait for the initial sync, then modify the instruction content.
    await vi.waitFor(
      () => {
        expect(events.some((e) => e.type === "synced")).toBe(true);
      },
      { timeout: 10000, interval: 100 },
    );
    await fs.writeFile(
      path.join(tmp.dir, "packs", "tools", "instructions", "base.md"),
      "## baseline rules v2\n",
    );

    await vi.waitFor(
      async () => {
        const content = await fs.readFile(path.join(tmp.dir, ".claude", "INSTRUCTIONS.md"), "utf8");
        expect(content).toContain("baseline rules v2");
      },
      { timeout: 10000, interval: 200 },
    );

    abort.abort();
    await watchDone;
  });
});
