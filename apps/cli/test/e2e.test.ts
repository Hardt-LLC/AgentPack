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
function run(args: string[], cwd: string): RunResult {
  const home = path.join(cwd, ".tmp-home");
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync("node", [cliPath, ...args], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      KIMI_CODE_HOME: path.join(home, ".kimi-code"),
      CODEX_HOME: path.join(home, ".codex"),
      GITHUB_TOKEN: "test-placeholder-not-a-secret",
      TERM: "dumb",
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("agentpack cli e2e — init/sync/diff/rollback/remove lifecycle", () => {
  let ws: string;

  beforeAll(() => {
    ws = freshTmpDir("agentpack-e2e-ws-");
  });

  it("init creates a workspace", () => {
    expectBuilt();
    const result = run(["init"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(ws, "agentpack.yaml"))).toBe(true);

    // Refuses to overwrite an existing workspace.
    const again = run(["init"], ws);
    expect(again.status).toBe(2);
  });

  it("validate passes on the fresh workspace", () => {
    expectBuilt();
    const result = run(["validate"], ws);
    expect(result.status, result.stderr).toBe(0);
  });

  it("plan is read-only", () => {
    expectBuilt();
    const result = run(["plan"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No files were modified.");
    for (const dir of [".claude", ".codex", ".kimi-code", ".agents"]) {
      expect(fs.existsSync(path.join(ws, dir)), `${dir} must not be created by plan`).toBe(false);
    }
  });

  it("sync installs all three targets and is idempotent", () => {
    expectBuilt();
    const first = run(["sync", "--trust", "example"], ws);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("Sync complete.");

    expect(fs.existsSync(path.join(ws, ".claude/skills/example"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".agents/skills/example"))).toBe(true);

    const claudeMd = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf8");
    const agentsMd = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
    expect(claudeMd).toContain("<!-- agentpack:begin example-notes -->");
    expect(agentsMd).toContain("<!-- agentpack:begin example-notes -->");

    const second = run(["sync", "--trust", "example"], ws);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("0 to create, 0 to update");
  });

  it("diff is clean right after sync", () => {
    expectBuilt();
    const result = run(["diff"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No differences.");
  });

  it("external edits conflict; --force overwrites", () => {
    expectBuilt();
    const claudePath = path.join(ws, "CLAUDE.md");
    const before = fs.readFileSync(claudePath, "utf8");
    fs.writeFileSync(
      claudePath,
      before.replace(
        "<!-- agentpack:end example-notes -->",
        "tampered\n<!-- agentpack:end example-notes -->",
      ),
    );

    const conflict = run(["sync", "--trust", "example"], ws);
    expect(conflict.status).toBe(3);
    expect(conflict.stderr).toContain("modified externally");
    expect(conflict.stderr).toContain("re-run with --force to overwrite");

    const forced = run(["sync", "--trust", "example", "--force"], ws);
    expect(forced.status, forced.stderr).toBe(0);

    const diff = run(["diff"], ws);
    expect(diff.status).toBe(0);
  });

  it("unmanaged content survives sync", () => {
    expectBuilt();
    fs.writeFileSync(
      path.join(ws, ".mcp.json"),
      JSON.stringify({ mcpServers: { unrelated: { command: "node", args: ["server.mjs"] } } }),
    );
    const claudePath = path.join(ws, "CLAUDE.md");
    fs.writeFileSync(claudePath, `My own notes\n\n${fs.readFileSync(claudePath, "utf8")}`);

    const result = run(["sync", "--trust", "example"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(claudePath, "utf8")).toContain("My own notes");
    const mcp = JSON.parse(fs.readFileSync(path.join(ws, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.unrelated).toBeDefined();
  });

  it("rollback restores previously backed-up content", async () => {
    expectBuilt();
    const claudePath = path.join(ws, "CLAUDE.md");
    const beforeSync = fs.readFileSync(claudePath, "utf8");

    // Change the pack so the next sync actually modifies CLAUDE.md (and backs it up).
    await sleep(20); // keep backup timestamps distinct
    fs.appendFileSync(path.join(ws, "packs/example/instructions/example.md"), "\nextra line\n");
    const sync = run(["sync", "--trust", "example"], ws);
    expect(sync.status, sync.stderr).toBe(0);
    expect(fs.readFileSync(claudePath, "utf8")).toContain("extra line");

    const rollback = run(["rollback"], ws);
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(rollback.stdout).toContain("Restored backup");
    expect(fs.readFileSync(claudePath, "utf8")).toBe(beforeSync);

    // Re-align state with the filesystem for the following steps.
    const resync = run(["sync", "--trust", "example", "--force"], ws);
    expect(resync.status, resync.stderr).toBe(0);
  });

  it("build emits plugin bundles for all targets", () => {
    expectBuilt();
    const result = run(["build", "--output", "dist"], ws);
    expect(result.status, result.stderr).toBe(0);
    for (const rel of [
      "dist/codex/example/.codex-plugin/plugin.json",
      "dist/claude/example/.claude-plugin/plugin.json",
      "dist/kimi/example/kimi.plugin.json",
    ]) {
      const file = path.join(ws, rel);
      expect(fs.existsSync(file), rel).toBe(true);
      expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
    }
  });

  it("doctor --json prints the stable envelope", () => {
    expectBuilt();
    const result = run(["doctor", "--json"], ws);
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as { version: number; command: string };
    expect(envelope.version).toBe(1);
    expect(envelope.command).toBe("doctor");
  });

  it("validate --json prints the stable envelope", () => {
    expectBuilt();
    const result = run(["validate", "--json"], ws);
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as { version: number; command: string; ok: boolean };
    expect(envelope.version).toBe(1);
    expect(envelope.command).toBe("validate");
    expect(envelope.ok).toBe(true);
  });

  it("remove deletes owned files and keeps unmanaged ones", () => {
    expectBuilt();
    const result = run(["remove", "example"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(ws, ".claude/skills/example"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".agents/skills/example"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".mcp.json"))).toBe(true);
    expect(fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf8")).toContain("My own notes");
  });
});

describe("agentpack cli e2e — security-review example workspace", () => {
  let ws: string;

  beforeAll(() => {
    ws = freshTmpDir("agentpack-e2e-sr-");
    fs.cpSync(path.join(repoRoot, "examples/security-review"), ws, { recursive: true });
  });

  it("validate passes and shows the codex hook as unsupported", () => {
    expectBuilt();
    const result = run(["validate"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("hook:block-dangerous-shell");
    expect(result.stdout).toContain("unsupported");
  });

  it("build produces bundles for every target", () => {
    expectBuilt();
    const result = run(["build"], ws);
    expect(result.status, result.stderr).toBe(0);
    for (const target of ["codex", "claude", "kimi"]) {
      expect(fs.existsSync(path.join(ws, "dist", target, "security-review"))).toBe(true);
    }
  });

  it("sync refuses untrusted executable packs with exit 4", () => {
    expectBuilt();
    const result = run(["sync"], ws);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("trust");
  });

  it("sync succeeds once the pack is trusted", () => {
    expectBuilt();
    const result = run(["sync", "--trust", "security-review"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Sync complete.");
  });
});
