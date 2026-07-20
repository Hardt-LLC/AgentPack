import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeWorkspaceId,
  emptyState,
  loadState,
  saveState,
  sha256,
  type SyncState,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-state-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("computeWorkspaceId", () => {
  it("depends on the yaml content only, not the root path", () => {
    const a = computeWorkspaceId("/some/root", "name: pack\n");
    const b = computeWorkspaceId("/other/root", "name: pack\n");
    expect(a).toBe(b);
    expect(a).toBe(sha256("name: pack\n"));
  });
});

describe("loadState / saveState", () => {
  it("returns an empty state with a computed workspace id when missing", async () => {
    await fs.writeFile(path.join(tmpDir, "agentpack.yaml"), "name: ws\n");
    const state = await loadState(tmpDir);
    expect(state.version).toBe(1);
    expect(state.lastSyncAt).toBeNull();
    expect(state.targets).toEqual({});
    expect(state.workspaceId).toBe(sha256("name: ws\n"));
  });

  it("round-trips a saved state", async () => {
    const state: SyncState = emptyState("sha256:abc");
    state.lastSyncAt = new Date().toISOString();
    state.targets["claude-code"] = {
      ownedFiles: [{ path: ".claude/skills/x", type: "file", checksum: "sha256:1" }],
      ownedConfigKeys: [
        { path: ".mcp.json", jsonPointer: "/mcpServers/github", checksum: "sha256:2" },
      ],
    };
    state.trust = { "my-pack": { contentHash: "sha256:3", grantedAt: new Date().toISOString() } };
    await saveState(tmpDir, state);
    expect(await loadState(tmpDir)).toEqual(state);
  });

  it("throws on a corrupt state file", async () => {
    await fs.mkdir(path.join(tmpDir, ".agentpack"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".agentpack", "state.json"), "{corrupt");
    await expect(loadState(tmpDir)).rejects.toThrow(/corrupt state file/);
  });
});
