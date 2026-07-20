import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Gateway } from "../src/index.js";

interface RecordedRequest {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface FakeHttpServer {
  server: http.Server;
  requests: RecordedRequest[];
  url: string;
}

const SESSION_ID = "test-session-1";

async function startFakeHttpServer(opts: {
  sse?: boolean;
  failStatus?: number;
}): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ headers: req.headers, body });
      if (opts.failStatus !== undefined) {
        res.writeHead(opts.failStatus).end("failure");
        return;
      }
      if (!("id" in body)) {
        res.writeHead(202).end();
        return;
      }
      const params = (body["params"] ?? {}) as Record<string, unknown>;
      let payload: Record<string, unknown>;
      switch (body["method"]) {
        case "initialize":
          payload = {
            jsonrpc: "2.0",
            id: body["id"],
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-http", version: "0.0.1" },
            },
          };
          break;
        case "tools/list":
          payload = {
            jsonrpc: "2.0",
            id: body["id"],
            result: {
              tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
            },
          };
          break;
        case "tools/call":
          payload = {
            jsonrpc: "2.0",
            id: body["id"],
            result: {
              content: [{ type: "text", text: JSON.stringify(params["arguments"] ?? {}) }],
            },
          };
          break;
        default:
          payload = {
            jsonrpc: "2.0",
            id: body["id"],
            error: { code: -32601, message: "Method not found" },
          };
      }
      res.writeHead(200, {
        "content-type": opts.sse === true ? "text/event-stream" : "application/json",
        "mcp-session-id": SESSION_ID,
      });
      res.end(
        opts.sse === true
          ? `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\ndata: ${JSON.stringify(payload)}\n\n`
          : JSON.stringify(payload),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, requests, url: `http://127.0.0.1:${address.port}/mcp` };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
  delete process.env["AGENTPACK_HTTP_TEST_VAR"];
});

function track(gateway: Gateway, fake: FakeHttpServer): void {
  cleanup.push(() => gateway.stop());
  cleanup.push(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));
}

function methods(fake: FakeHttpServer): unknown[] {
  return fake.requests.map((request) => request.body["method"]);
}

describe("http downstream (application/json)", () => {
  it("handshakes, captures and resends the session id, and serves tools", async () => {
    process.env["AGENTPACK_HTTP_TEST_VAR"] = "http-secret-value";
    const fake = await startFakeHttpServer({});
    const gateway = new Gateway(
      {
        version: 1,
        servers: {
          web: {
            transport: "http",
            url: fake.url,
            headers: { "X-Api-Key": "${AGENTPACK_HTTP_TEST_VAR}" },
          },
        },
      },
      { log: () => {} },
    );
    track(gateway, fake);
    await gateway.start();
    expect(gateway.status()).toEqual([{ name: "web", state: "ok", tools: 1 }]);

    const list = (await gateway.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["web__echo"]);

    const call = (await gateway.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "web__echo", arguments: { ping: true } },
    })) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]?.text).toBe(JSON.stringify({ ping: true }));

    // tools/list is cached at startup; the upstream tools/list is served from cache.
    expect(methods(fake)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    const [initialize, ...rest] = fake.requests;
    expect(initialize?.headers["mcp-session-id"]).toBeUndefined();
    for (const request of rest) {
      expect(request.headers["mcp-session-id"]).toBe(SESSION_ID);
    }
    expect(initialize?.headers["content-type"]).toBe("application/json");
    expect(initialize?.headers["accept"]).toBe("application/json, text/event-stream");
    expect(initialize?.headers["x-api-key"]).toBe("http-secret-value");
  });
});

describe("http downstream (text/event-stream)", () => {
  it("parses SSE data lines and picks the message with the matching id", async () => {
    const fake = await startFakeHttpServer({ sse: true });
    const gateway = new Gateway(
      { version: 1, servers: { web: { transport: "http", url: fake.url } } },
      { log: () => {} },
    );
    track(gateway, fake);
    await gateway.start();
    expect(gateway.status()).toEqual([{ name: "web", state: "ok", tools: 1 }]);
    const call = (await gateway.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web__echo", arguments: { via: "sse" } },
    })) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]?.text).toBe(JSON.stringify({ via: "sse" }));
  });
});

describe("http downstream failures", () => {
  it("degrades the server on HTTP 5xx", async () => {
    const fake = await startFakeHttpServer({ failStatus: 500 });
    const gateway = new Gateway(
      { version: 1, servers: { web: { transport: "http", url: fake.url } } },
      { log: () => {} },
    );
    track(gateway, fake);
    await gateway.start();
    const [entry] = gateway.status();
    expect(entry?.state).toBe("degraded");
    expect(entry?.error).toContain("HTTP 500");
    const list = (await gateway.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: unknown[] };
    };
    expect(list.result.tools).toEqual([]);
  });
});
