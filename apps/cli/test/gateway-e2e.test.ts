import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");
const cliPath = path.join(repoRoot, "apps/cli/dist/cli.mjs");

let workspace: string;
let homeDir: string;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: workspace,
    env: {
      HOME: homeDir,
      KIMI_CODE_HOME: path.join(homeDir, ".kimi-code"),
      CODEX_HOME: path.join(homeDir, ".codex"),
      PATH: process.env.PATH ?? "",
      TERM: "dumb",
      ...env,
    },
    encoding: "utf8",
  });
}

/** Speak NDJSON JSON-RPC to the gateway over stdio. */
function gatewayRpc(configPath: string, messages: object[]): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, "gateway", "run", "--config", configPath], {
      env: { PATH: process.env.PATH ?? "", HOME: homeDir, FAKE_VAR: "resolved-value" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const responses: object[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`gateway timed out; got ${responses.length} responses; buffer=${buffer}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
      if (responses.length >= messages.filter((m) => "id" in m).length) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    });
    child.stderr.on("data", () => undefined);
    child.on("error", reject);
    for (const msg of messages) child.stdin.write(JSON.stringify(msg) + "\n");
    // Keep stdin open: ending it triggers the gateway's graceful shutdown,
    // which stops downstreams before pending calls complete.
  });
}

beforeAll(async () => {
  // The bundle is built once by vitest globalSetup (apps/cli/test/global-setup.ts).
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-gw-e2e-"));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-gw-home-"));

  // A fake downstream MCP server (stdio, NDJSON).
  await fs.writeFile(
    path.join(workspace, "fake-mcp.mjs"),
    `let buffer = "";
process.stdin.on("data", (c) => {
  buffer += c;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const send = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "echo", inputSchema: { type: "object" } },
      { name: "secret-tool", description: "x", inputSchema: { type: "object" } },
    ] } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "env=" + (process.env.FAKE_FROM_GATEWAY ?? "unset") }] } });
    else if (msg.id) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nf" } });
  }
});
`,
  );

  // Workspace with one pack exposing the fake server + gateway mode enabled.
  await fs.mkdir(path.join(workspace, "packs", "gw"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "agentpack.yaml"),
    `apiVersion: agentpack.dev/v1alpha1
kind: Workspace
packs:
  - path: ./packs/gw
profiles:
  default:
    packs: [gw]
    targets: [kimi]
    scope: user
    installMode: auto
gateway:
  enabled: true
`,
  );
  await fs.writeFile(
    path.join(workspace, "packs", "gw", "pack.yaml"),
    `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: gw
  version: 0.1.0
spec:
  mcpServers:
    fake:
      transport: stdio
      command: ${process.execPath}
      args:
        - ${path.join(workspace, "fake-mcp.mjs")}
      env:
        FAKE_FROM_GATEWAY:
          value: literal-ok
        FROM_VAR:
          fromEnv: FAKE_VAR
      denyTools:
        - secret-tool
`,
  );
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("gateway e2e", () => {
  it("setup installs a single gateway entry and keeps individual servers out", async () => {
    const setup = run(["gateway", "setup", "--targets", "kimi"]);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("1 server(s)");

    const mcpPath = path.join(homeDir, ".kimi-code", "mcp.json");
    const mcp = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["agentpack"]);
    expect(mcp.mcpServers.agentpack.args[1]).toBe("gateway");

    // gateway.json has the canonical server with unresolved env refs.
    const gw = JSON.parse(await fs.readFile(path.join(workspace, "gateway.json"), "utf8"));
    expect(gw.servers.fake.env.FROM_VAR).toBe("${FAKE_VAR}");

    // A normal sync in gateway mode keeps the single entry (idempotent).
    const sync = run(["sync", "--trust", "gw"]);
    expect(sync.status).toBe(0);
    const mcp2 = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(Object.keys(mcp2.mcpServers)).toEqual(["agentpack"]);
  });

  it("gateway run aggregates downstream tools with namespacing and denylist", async () => {
    const responses = (await gatewayRpc(path.join(workspace, "gateway.json"), [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fake__echo", arguments: {} },
      },
    ])) as Array<{
      id: number;
      result?: {
        serverInfo?: { name: string };
        tools?: Array<{ name: string }>;
        content?: Array<{ text: string }>;
      };
      error?: { code: number; message: string };
    }>;

    const init = responses.find((r) => r.id === 1)!;
    expect(init.result?.serverInfo?.name).toBe("agentpack-gateway");

    const list = responses.find((r) => r.id === 2)!;
    const names = (list.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("fake__echo");
    expect(names).not.toContain("fake__secret-tool"); // denyTools

    const call = responses.find((r) => r.id === 3)!;
    expect(call.result?.content?.[0]?.text).toBe("env=literal-ok");
  });

  it("gateway uninstall removes the entry", async () => {
    const result = run(["gateway", "uninstall", "--targets", "kimi"]);
    expect(result.status).toBe(0);
    const mcp = JSON.parse(await fs.readFile(path.join(homeDir, ".kimi-code", "mcp.json"), "utf8"));
    expect(mcp.mcpServers?.agentpack).toBeUndefined();
  });
});
