import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = path.join(repoRoot, "apps/cli/dist/cli.mjs");

let buildError: string | undefined;
const tmpRoots: string[] = [];

beforeAll(() => {
  // The bundle is built once by vitest globalSetup (apps/cli/test/global-setup.ts).
  if (!fs.existsSync(cliPath)) buildError = `CLI bundle missing: ${cliPath}`;
}, 120000);

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the built CLI with a minimal, secret-free environment. */
function run(args: string[], cwd: string, extraEnv: Record<string, string> = {}): RunResult {
  const home = path.join(cwd, ".tmp-home");
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync("node", [cliPath, ...args], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      KIMI_CODE_HOME: path.join(home, ".kimi-code"),
      CODEX_HOME: path.join(home, ".codex"),
      TERM: "dumb",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function freshTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function expectBuilt(): void {
  if (buildError) throw new Error(`skipping e2e: ${buildError}`);
}

/** The CLI resolves workspaces to their real path (/var → /private/var on macOS). */
function real(p: string): string {
  return fs.realpathSync(p);
}

describe("agentpack cli e2e — service", () => {
  it("service install writes the unit file; status reports it", () => {
    const ws = freshTmpDir("agentpack-e2e-service-");
    expectBuilt();
    expect(run(["init"], ws).status).toBe(0);

    // Never load a real agent from tests — assert the file, not the load.
    const install = run(["service", "install"], ws, { AGENTPACK_SERVICE_SKIP_LOAD: "1" });
    expect(install.status, install.stderr).toBe(0);

    const home = path.join(ws, ".tmp-home");
    if (process.platform === "darwin") {
      const plistPath = path.join(home, "Library", "LaunchAgents", "dev.agentpack.watch.plist");
      expect(install.stdout).toContain(`Service file: ${plistPath}`);
      const plist = fs.readFileSync(plistPath, "utf8");
      expect(plist).toContain("<string>dev.agentpack.watch</string>");
      for (const arg of [cliPath, "watch", "--collect", "--workspace", real(ws)]) {
        expect(plist).toContain(`<string>${arg}</string>`);
      }
      expect(plist).toContain("<key>RunAtLoad</key>");
      expect(plist).toContain("<key>KeepAlive</key>");
      expect(plist).toContain(path.join(real(ws), ".agentpack", "service.log"));
    } else {
      const unitPath = path.join(home, ".config", "systemd", "user", "agentpack-watch.service");
      expect(install.stdout).toContain(`Service file: ${unitPath}`);
      const unit = fs.readFileSync(unitPath, "utf8");
      expect(unit).toContain(
        `ExecStart=${process.execPath} ${cliPath} watch --collect --workspace ${real(ws)}`,
      );
      expect(unit).toContain("Restart=always");
      expect(unit).toContain("WantedBy=default.target");
    }
    expect(install.stdout).toContain(
      `Log file: ${path.join(real(ws), ".agentpack", "service.log")}`,
    );

    const status = run(["service", "status"], ws, { AGENTPACK_SERVICE_SKIP_LOAD: "1" });
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("Installed: yes");
  });
});

describe("agentpack cli e2e — hooks", () => {
  it("hooks install/uninstall round-trips in a fake HOME", () => {
    const ws = freshTmpDir("agentpack-e2e-hooks-");
    expectBuilt();
    expect(run(["init"], ws).status).toBe(0);
    const home = path.join(ws, ".tmp-home");
    const settingsPath = path.join(home, ".claude", "settings.json");

    const install = run(["hooks", "install", "--target", "claude"], ws);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain("installed SessionStart collect hook");

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
    };
    expect(settings.hooks.SessionStart).toHaveLength(1);
    const hook = settings.hooks.SessionStart[0]!.hooks[0]!;
    expect(hook.timeout).toBe(30);
    expect(hook.command).toContain(
      `${cliPath} collect --from claude --quiet --workspace ${real(ws)}`,
    );

    // Idempotent.
    const again = run(["hooks", "install", "--target", "claude"], ws);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("already present");

    const uninstall = run(["hooks", "uninstall", "--target", "claude"], ws);
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(uninstall.stdout).toContain("Collect hook removed.");
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(after.hooks.SessionStart).toBeUndefined();

    // Non-claude targets are rejected gracefully.
    const codex = run(["hooks", "install", "--target", "codex"], ws);
    expect(codex.status, codex.stderr).toBe(0);
    expect(codex.stdout).toContain("no hook system");
  });
});

describe("agentpack cli e2e — collect --quiet + promote", () => {
  it("quiet collect prints one line; promote shares the inbox pack", () => {
    const ws = freshTmpDir("agentpack-e2e-promote-");
    expectBuilt();
    expect(run(["init"], ws).status).toBe(0);
    const home = path.join(ws, ".tmp-home");

    // Fake native claude install.
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { pluginserver: { type: "stdio", command: "node", args: ["server.mjs"] } },
      }),
    );

    const quiet = run(["collect", "--from", "claude", "--quiet"], ws);
    expect(quiet.status, quiet.stderr).toBe(0);
    expect(quiet.stdout.trim()).toBe(
      "AgentPack: collected 1 new item(s) from claude → packs/inbox-claude (say 'promote' to share)",
    );

    // Quiet again: nothing changed → no stdout at all.
    const quietNoop = run(["collect", "--from", "claude", "--quiet"], ws);
    expect(quietNoop.status, quietNoop.stderr).toBe(0);
    expect(quietNoop.stdout.trim()).toBe("");

    const promote = run(["promote", "inbox-claude"], ws);
    expect(promote.status, promote.stderr).toBe(0);
    expect(promote.stdout).toContain("Promoted: inbox-claude");
    expect(promote.stdout).toContain("Profile updated: yes");
    expect(promote.stdout).toContain("Trust granted: yes");
    expect(promote.stdout).toContain("Sync: applied");

    // The promoted server landed in the project-scope claude config.
    const mcp = JSON.parse(fs.readFileSync(path.join(ws, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers)).toContain("pluginserver");

    // Promoting an unknown pack fails cleanly.
    const unknown = run(["promote", "nope"], ws);
    expect(unknown.status).toBe(1);
  });
});
