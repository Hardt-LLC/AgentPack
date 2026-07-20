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

describe("agentpack cli e2e — collect", () => {
  let ws: string;
  let home: string;

  beforeAll(() => {
    ws = freshTmpDir("agentpack-e2e-collect-");
    expectBuilt();
    const init = run(["init"], ws);
    expect(init.status, init.stderr).toBe(0);

    // Fake native claude install in the isolated HOME: one MCP server and
    // one skill installed directly into the agent (not via AgentPack).
    home = path.join(ws, ".tmp-home");
    fs.mkdirSync(path.join(home, ".claude", "skills", "native-tool"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          pluginserver: { type: "stdio", command: "node", args: ["server.mjs"] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, ".claude", "skills", "native-tool", "SKILL.md"),
      "---\nname: native-tool\ndescription: installed natively\n---\n\n# native-tool\n",
    );
  });

  it("collects native changes into packs/inbox-claude", () => {
    const result = run(["collect", "--from", "claude"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("+ server pluginserver");
    expect(result.stdout).toContain("+ skill native-tool");
    expect(result.stdout).toContain("Review packs/inbox-claude");

    const packYaml = fs.readFileSync(path.join(ws, "packs", "inbox-claude", "pack.yaml"), "utf8");
    expect(packYaml).toContain("pluginserver");
    expect(packYaml).toContain("./skills/native-tool");
    expect(
      fs.existsSync(path.join(ws, "packs", "inbox-claude", "skills", "native-tool", "SKILL.md")),
    ).toBe(true);

    // agentpack.yaml references the inbox pack, but no profile does.
    const workspaceYaml = fs.readFileSync(path.join(ws, "agentpack.yaml"), "utf8");
    expect(workspaceYaml).toContain("- path: ./packs/inbox-claude");
    const profilesSection = workspaceYaml.slice(workspaceYaml.indexOf("profiles:"));
    expect(profilesSection).not.toContain("inbox-claude");
  });

  it("second collect finds no new items", () => {
    const result = run(["collect", "--from", "claude"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no new items");
    expect(result.stdout).toContain("~ server pluginserver skipped (already canonical)");

    const workspaceYaml = fs.readFileSync(path.join(ws, "agentpack.yaml"), "utf8");
    expect(workspaceYaml.match(/\.\/packs\/inbox-claude/g)).toHaveLength(1);
  });

  it("validate passes with the inbox pack referenced", () => {
    const result = run(["validate"], ws);
    expect(result.status, result.stderr).toBe(0);
  });

  it("collect --dry-run writes nothing", () => {
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          pluginserver: { type: "stdio", command: "node", args: ["server.mjs"] },
          another: { type: "stdio", command: "deno", args: ["serve.ts"] },
        },
      }),
    );
    const before = fs.readFileSync(path.join(ws, "packs", "inbox-claude", "pack.yaml"), "utf8");
    const result = run(["collect", "--from", "claude", "--dry-run"], ws);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("+ server another");
    expect(result.stdout).toContain("Dry run");
    expect(fs.readFileSync(path.join(ws, "packs", "inbox-claude", "pack.yaml"), "utf8")).toBe(
      before,
    );
  });
});
