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

function run(
  args: string[],
  cwd: string,
  home: string,
  extraEnv: Record<string, string> = {},
): RunResult {
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

describe("agentpack cli e2e — setup wizard", () => {
  it("refuses to run non-interactively without --yes (exit 2)", () => {
    expectBuilt();
    const dir = freshTmpDir("agentpack-e2e-setup-nontty-");
    const result = run(["setup"], dir, path.join(dir, "home"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--yes");
  });

  it("setup --yes goes from zero to synced in a fake HOME", () => {
    expectBuilt();
    const dir = freshTmpDir("agentpack-e2e-setup-");
    const home = path.join(dir, "home");
    const ws = path.join(dir, "workspace");

    // Fake claude installation: stub executable + user-scope config.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const stub = path.join(bin, "claude");
    fs.writeFileSync(stub, '#!/bin/sh\necho "claude 1.2.3"\n');
    fs.chmodSync(stub, 0o755);

    fs.mkdirSync(path.join(home, ".claude", "skills", "x"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { "my-server": { command: "node", args: ["server.mjs"] } },
      }),
    );
    fs.writeFileSync(
      path.join(home, ".claude", "skills", "x", "SKILL.md"),
      "---\nname: x\ndescription: test skill\n---\n\n# x\n",
    );

    const result = run(["setup", "--yes", "--workspace", ws], dir, home, {
      AGENTPACK_SERVICE_SKIP_LOAD: "1",
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);

    // Workspace created (init logic) and the imported pack registered.
    expect(fs.existsSync(path.join(ws, "agentpack.yaml"))).toBe(true);
    const importedPack = fs.readFileSync(
      path.join(ws, "packs", "imported-claude", "pack.yaml"),
      "utf8",
    );
    expect(importedPack).toContain("my-server");
    expect(
      fs.existsSync(path.join(ws, "packs", "imported-claude", "skills", "x", "SKILL.md")),
    ).toBe(true);

    // Profile exists with the imported pack, claude target, user scope, gateway on.
    const workspaceYaml = fs.readFileSync(path.join(ws, "agentpack.yaml"), "utf8");
    expect(workspaceYaml).toContain("imported-claude");
    expect(workspaceYaml).toContain("- claude");
    expect(workspaceYaml).toContain("scope: user");
    expect(workspaceYaml).toContain("enabled: true");

    // Sync applied; gateway entry installed.
    expect(result.stdout).toContain("Sync applied");
    expect(fs.existsSync(path.join(ws, "gateway.json"))).toBe(true);
    const claudeJson = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claudeJson.mcpServers.agentpack).toBeDefined();

    // Service file written (load skipped via AGENTPACK_SERVICE_SKIP_LOAD).
    const serviceFile =
      process.platform === "darwin"
        ? path.join(home, "Library", "LaunchAgents", "dev.agentpack.watch.plist")
        : path.join(home, ".config", "systemd", "user", "agentpack-watch.service");
    expect(fs.existsSync(serviceFile), `service file ${serviceFile}`).toBe(true);

    // Claude SessionStart collect hook written.
    const settings = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("collect --from");

    // Outro summary printed.
    expect(result.stdout).toContain("Setup complete");
  });
});
