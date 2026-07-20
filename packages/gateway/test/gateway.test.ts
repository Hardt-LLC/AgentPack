import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Gateway, type GatewayConfig, type GatewayServerConfig } from "../src/index.js";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));

function fakeServer(extra?: Partial<GatewayServerConfig>): GatewayServerConfig {
  return { transport: "stdio", command: process.execPath, args: [FAKE_SERVER], ...extra };
}

interface RpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function asRpc(value: unknown): RpcResponse {
  return value as RpcResponse;
}

function toolNames(result: unknown): string[] {
  const { tools } = result as { tools: Array<{ name: string }> };
  return tools.map((tool) => tool.name).sort();
}

function firstText(result: unknown): string {
  const { content } = result as { content: Array<{ type: string; text: string }> };
  const first = content[0];
  if (first === undefined) throw new Error("no content in tool result");
  return first.text;
}

async function listTools(gateway: Gateway, id = 99): Promise<unknown> {
  return asRpc(await gateway.handleMessage({ jsonrpc: "2.0", id, method: "tools/list" })).result;
}

async function callTool(
  gateway: Gateway,
  name: string,
  args?: Record<string, unknown>,
  id = 7,
): Promise<RpcResponse> {
  return asRpc(
    await gateway.handleMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args ?? {} },
    }),
  );
}

const noop = (): void => {};
const gateways: Gateway[] = [];

function makeGateway(config: GatewayConfig): Gateway {
  const gateway = new Gateway(config, { log: noop });
  gateways.push(gateway);
  return gateway;
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  delete process.env["AGENTPACK_TEST_VAR"];
});

describe("upstream protocol", () => {
  it("answers initialize with the expected handshake shape", async () => {
    const gateway = makeGateway({ version: 1, servers: {} });
    const response = asRpc(
      await gateway.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x" } },
      }),
    );
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    const result = response.result as {
      protocolVersion: string;
      capabilities: { tools: { listChanged: boolean } };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo).toEqual({ name: "agentpack-gateway", version: "0.1.0" });
  });

  it("defaults the protocol version when the client omits it", async () => {
    const gateway = makeGateway({ version: 1, servers: {} });
    const response = asRpc(
      await gateway.handleMessage({ jsonrpc: "2.0", id: "a", method: "initialize" }),
    );
    expect((response.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
  });

  it("answers ping with an empty result", async () => {
    const gateway = makeGateway({ version: 1, servers: {} });
    const response = asRpc(await gateway.handleMessage({ jsonrpc: "2.0", id: 2, method: "ping" }));
    expect(response.result).toEqual({});
  });

  it("returns -32601 for unknown methods with an id", async () => {
    const gateway = makeGateway({ version: 1, servers: {} });
    const response = asRpc(
      await gateway.handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
    );
    expect(response.error).toEqual({ code: -32601, message: "Method not found" });
  });

  it("produces no response for notifications", async () => {
    const gateway = makeGateway({ version: 1, servers: {} });
    expect(
      await gateway.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
    expect(
      await gateway.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {},
      }),
    ).toBeUndefined();
  });
});

describe("stdio aggregation", () => {
  it("namespaces tools from two servers and routes calls to the right one", async () => {
    const gateway = makeGateway({
      version: 1,
      servers: {
        "srv-a": fakeServer({ env: { FAKE_SERVER_ENV: "alpha" } }),
        "srv-b": fakeServer({ env: { FAKE_SERVER_ENV: "beta" } }),
      },
    });
    await gateway.start();
    const names = toolNames(await listTools(gateway));
    expect(names).toContain("srv-a__echo");
    expect(names).toContain("srv-b__echo");
    expect(names).toContain("srv-a__fail");

    const echo = await callTool(gateway, "srv-a__echo", { hello: "world" });
    expect(echo.error).toBeUndefined();
    expect(firstText(echo.result)).toBe(JSON.stringify({ hello: "world" }));

    // The env tool proves the call reached the right downstream.
    expect(firstText((await callTool(gateway, "srv-a__env")).result)).toBe("alpha");
    expect(firstText((await callTool(gateway, "srv-b__env")).result)).toBe("beta");
  });

  it("hides denyTools and filters with allowTools", async () => {
    const gateway = makeGateway({
      version: 1,
      servers: {
        denied: fakeServer({ denyTools: ["fail"] }),
        allowed: fakeServer({ allowTools: ["echo"] }),
      },
    });
    await gateway.start();
    const names = toolNames(await listTools(gateway));
    expect(names).toContain("denied__echo");
    expect(names).not.toContain("denied__fail");
    expect(names).toEqual(["allowed__echo", "denied__echo", "denied__env"]);
  });

  it("returns -32602 for unknown tools and unknown prefixes", async () => {
    const gateway = makeGateway({ version: 1, servers: { "srv-a": fakeServer() } });
    await gateway.start();
    const unknownTool = await callTool(gateway, "srv-a__nope");
    expect(unknownTool.error?.code).toBe(-32602);
    expect(unknownTool.error?.message).toContain('unknown tool "srv-a__nope"');
    const unknownPrefix = await callTool(gateway, "ghost__echo");
    expect(unknownPrefix.error?.code).toBe(-32602);
    expect(unknownPrefix.error?.message).toContain('unknown server prefix "ghost"');
  });

  it("surfaces downstream tool errors as JSON-RPC errors", async () => {
    const gateway = makeGateway({ version: 1, servers: { "srv-a": fakeServer() } });
    await gateway.start();
    const response = await callTool(gateway, "srv-a__fail");
    expect(response.error?.code).toBe(-32603);
    expect(response.error?.message).toContain("intentional failure");
  });

  it("redacts secrets in downstream error messages", async () => {
    const gateway = makeGateway({ version: 1, servers: { "srv-a": fakeServer() } });
    await gateway.start();
    const response = await callTool(gateway, "srv-a__fail", {
      message: "boom: sk-abcdefghijklmnop and Bearer supersecrettoken123",
    });
    expect(response.error?.message).toContain("[REDACTED]");
    expect(response.error?.message).not.toContain("sk-abcdefghijklmnop");
    expect(response.error?.message).not.toContain("supersecrettoken123");
  });
});

describe("env resolution", () => {
  it("resolves ${VAR} from the gateway env and passes it to the child", async () => {
    process.env["AGENTPACK_TEST_VAR"] = "resolved-value-123";
    const gateway = makeGateway({
      version: 1,
      servers: { "srv-a": fakeServer({ env: { FAKE_SERVER_ENV: "${AGENTPACK_TEST_VAR}" } }) },
    });
    await gateway.start();
    expect(gateway.status()).toEqual([{ name: "srv-a", state: "ok", tools: 3 }]);
    expect(firstText((await callTool(gateway, "srv-a__env")).result)).toBe("resolved-value-123");
  });

  it("degrades a server with a missing variable but keeps serving the rest", async () => {
    delete process.env["AGENTPACK_MISSING_VAR"];
    const gateway = makeGateway({
      version: 1,
      servers: {
        broken: fakeServer({ env: { FAKE_SERVER_ENV: "${AGENTPACK_MISSING_VAR}" } }),
        healthy: fakeServer(),
      },
    });
    await gateway.start();
    const status = gateway.status();
    const broken = status.find((entry) => entry.name === "broken");
    expect(broken?.state).toBe("degraded");
    expect(broken?.tools).toBe(0);
    expect(broken?.error).toContain("AGENTPACK_MISSING_VAR");
    expect(status.find((entry) => entry.name === "healthy")?.state).toBe("ok");
    const names = toolNames(await listTools(gateway));
    expect(names).toContain("healthy__echo");
    expect(names.some((name) => name.startsWith("broken__"))).toBe(false);
  });
});

describe("degraded servers", () => {
  it("degrades a server whose command does not exist", async () => {
    const gateway = makeGateway({
      version: 1,
      servers: {
        ghost: fakeServer({ command: "agentpack-definitely-not-a-real-command-xyz", args: [] }),
        healthy: fakeServer(),
      },
    });
    await gateway.start();
    const ghost = gateway.status().find((entry) => entry.name === "ghost");
    expect(ghost?.state).toBe("degraded");
    expect(ghost?.error).toBeTruthy();
    expect(toolNames(await listTools(gateway))).toContain("healthy__echo");
  });
});
