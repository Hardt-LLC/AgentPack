import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import {
  createRegistry,
  installCollectHook,
  loadWorkspace,
  uninstallCollectHook,
} from "../src/index.js";
import { createFakeAdapter, writeWorkspace } from "./helpers.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  tmp = await makeTempDir();
});
afterEach(async () => {
  await tmp.cleanup();
});

const CLI = "/usr/local/bin/agentpack";

function settingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

async function readSettings(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(settingsPath(home), "utf8")) as Record<string, unknown>;
}

const USER_HOOKS = {
  model: "opus",
  hooks: {
    SessionStart: [
      { matcher: "startup", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] },
    ],
    PreToolUse: [{ hooks: [{ type: "command", command: "lint" }] }],
  },
};

describe("collect-hooks", () => {
  it("installs into existing settings, preserving the user's hooks", async () => {
    await writeWorkspace(tmp.dir);
    const workspace = await loadWorkspace(tmp.dir);
    const registry = createRegistry([createFakeAdapter("claude")]);
    const home = path.join(tmp.dir, "home");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(settingsPath(home), JSON.stringify(USER_HOOKS, null, 2));

    const result = await installCollectHook(workspace, registry, {
      target: "claude",
      cliPath: CLI,
      homeDir: home,
    });
    expect(result.installed).toBe(true);
    expect(result.path).toBe(settingsPath(home));

    const settings = await readSettings(home);
    // Everything the user had is preserved.
    expect(settings.model).toBe("opus");
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    const sessionStart = hooks.SessionStart as Array<{
      matcher?: string;
      hooks: Array<{ command?: string }>;
    }>;
    expect(sessionStart).toHaveLength(2);
    expect(sessionStart[0]!.matcher).toBe("startup");
    expect(sessionStart[0]!.hooks[0]!.command).toBe("echo hi");

    const entry = sessionStart[1]!;
    expect(entry.hooks).toHaveLength(1);
    const hook = entry.hooks[0] as { type: string; command: string; timeout: number };
    expect(hook.type).toBe("command");
    expect(hook.timeout).toBe(30);
    expect(hook.command).toContain("collect --from claude --quiet");
    expect(hook.command).toContain(`--workspace ${tmp.dir}`);
    expect(hook.command.startsWith(`${process.execPath} ${CLI} `)).toBe(true);

    // A backup of the previous settings file was taken.
    const backups = await fs.readdir(path.join(tmp.dir, ".agentpack", "backups"));
    expect(backups.some((name) => name.startsWith("collect-hook-"))).toBe(true);
  });

  it("is idempotent and round-trips with uninstall", async () => {
    await writeWorkspace(tmp.dir);
    const workspace = await loadWorkspace(tmp.dir);
    const registry = createRegistry([createFakeAdapter("claude")]);
    const home = path.join(tmp.dir, "home");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(settingsPath(home), JSON.stringify(USER_HOOKS, null, 2));

    const first = await installCollectHook(workspace, registry, {
      target: "claude",
      cliPath: CLI,
      homeDir: home,
    });
    expect(first.installed).toBe(true);
    const second = await installCollectHook(workspace, registry, {
      target: "claude",
      cliPath: CLI,
      homeDir: home,
    });
    expect(second.installed).toBe(false);
    expect(second.message).toContain("already present");
    let settings = await readSettings(home);
    expect((settings.hooks as Record<string, unknown[]>).SessionStart).toHaveLength(2);

    // Uninstall removes only the AgentPack entry.
    const removed = await uninstallCollectHook(workspace, registry, {
      target: "claude",
      homeDir: home,
    });
    expect(removed.removed).toBe(true);
    settings = await readSettings(home);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart).toHaveLength(1);
    expect((hooks.SessionStart as Array<{ matcher?: string }>)[0]!.matcher).toBe("startup");
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(settings.model).toBe("opus");

    // Second uninstall is a no-op.
    const again = await uninstallCollectHook(workspace, registry, {
      target: "claude",
      homeDir: home,
    });
    expect(again.removed).toBe(false);
  });

  it("creates settings.json when missing and removes an emptied SessionStart array", async () => {
    await writeWorkspace(tmp.dir);
    const workspace = await loadWorkspace(tmp.dir);
    const registry = createRegistry([createFakeAdapter("claude")]);
    const home = path.join(tmp.dir, "home");

    const installed = await installCollectHook(workspace, registry, {
      target: "claude",
      cliPath: CLI,
      homeDir: home,
    });
    expect(installed.installed).toBe(true);
    let settings = await readSettings(home);
    expect(Object.keys(settings)).toEqual(["hooks"]);

    const removed = await uninstallCollectHook(workspace, registry, {
      target: "claude",
      homeDir: home,
    });
    expect(removed.removed).toBe(true);
    settings = await readSettings(home);
    expect((settings.hooks as Record<string, unknown>).SessionStart).toBeUndefined();
  });

  it("rejects targets without a hook system", async () => {
    await writeWorkspace(tmp.dir);
    const workspace = await loadWorkspace(tmp.dir);
    const registry = createRegistry([createFakeAdapter("codex")]);
    const home = path.join(tmp.dir, "home");

    const installed = await installCollectHook(workspace, registry, {
      target: "codex",
      cliPath: CLI,
      homeDir: home,
    });
    expect(installed.installed).toBe(false);
    expect(installed.message).toContain("no hook system");
    expect(installed.diagnostics[0]?.severity).toBe("warning");

    const removed = await uninstallCollectHook(workspace, registry, {
      target: "codex",
      homeDir: home,
    });
    expect(removed.removed).toBe(false);
    expect(removed.diagnostics[0]?.message).toContain("no hook system");
  });
});
