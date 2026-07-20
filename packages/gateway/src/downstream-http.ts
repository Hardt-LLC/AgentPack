import {
  DEFAULT_PROTOCOL_VERSION,
  DEFAULT_STARTUP_TIMEOUT_MS,
  GATEWAY_NAME,
  GATEWAY_VERSION,
  resolveEnvTemplates,
  type GatewayServerConfig,
} from "./config.js";
import type { DownstreamClient, McpTool } from "./aggregate.js";
import { redactSecrets } from "./redact.js";

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/**
 * Streamable HTTP downstream. The legacy "sse" transport is treated the same
 * way for request/response (MVP: no server-push event channel is consumed).
 */
export class HttpDownstream implements DownstreamClient {
  private sessionId?: string;
  private headers: Record<string, string> = {};
  private nextId = 1;

  constructor(
    readonly name: string,
    private readonly config: GatewayServerConfig,
    private readonly log: (msg: string) => void,
  ) {}

  async start(): Promise<McpTool[]> {
    if (this.config.url === undefined) {
      throw new Error(`server "${this.name}": ${this.config.transport} transport requires "url"`);
    }
    const { resolved, missing } = resolveEnvTemplates(this.config.headers);
    if (missing.length > 0) {
      throw new Error(
        `server "${this.name}": missing environment variable(s): ${missing.join(", ")}`,
      );
    }
    this.headers = resolved;

    const timeoutMs = this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    await this.request(
      "initialize",
      {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: GATEWAY_NAME, version: GATEWAY_VERSION },
      },
      timeoutMs,
    );
    await this.notify("notifications/initialized", timeoutMs);
    const result = (await this.request("tools/list", {}, timeoutMs)) as
      { tools?: unknown } | undefined;
    const tools = result && Array.isArray(result.tools) ? (result.tools as McpTool[]) : [];
    return tools;
  }

  async callTool(toolName: string, args: unknown, timeoutMs: number): Promise<unknown> {
    try {
      return await this.request("tools/call", { name: toolName, arguments: args ?? {} }, timeoutMs);
    } catch (err) {
      throw new Error(redactSecrets((err as Error).message));
    }
  }

  async stop(): Promise<void> {
    // Stateless MVP: no session teardown request is sent.
  }

  private buildHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
      ...(this.sessionId !== undefined ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    const message = await this.extractMessage(response, id);
    if (message === undefined) {
      throw new Error(`server "${this.name}": no JSON-RPC response for "${method}"`);
    }
    if (message.error !== undefined) {
      const text =
        typeof message.error.message === "string" ? message.error.message : "downstream error";
      throw new Error(`server "${this.name}": ${redactSecrets(text)}`);
    }
    return message.result;
  }

  private async notify(method: string, timeoutMs: number): Promise<void> {
    // Expect 200/202; the body (if any) carries no response and is ignored.
    await this.post({ jsonrpc: "2.0", method }, timeoutMs);
  }

  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.config.url as string, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId !== null) this.sessionId = sessionId;
      if (!response.ok) {
        throw new Error(
          `server "${this.name}": HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }
      return response;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`server "${this.name}": request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async extractMessage(
    response: Response,
    id: number,
  ): Promise<JsonRpcResponse | undefined> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const body = await response.text();
      for (const line of body.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload.length === 0) continue;
        try {
          const message = JSON.parse(payload) as JsonRpcResponse;
          if (message.id === id) return message;
        } catch {
          this.log(`gateway: server "${this.name}" sent a malformed SSE data line, ignoring`);
        }
      }
      return undefined;
    }
    if (contentType.includes("application/json")) {
      const text = await response.text();
      if (text.trim().length === 0) return undefined;
      return JSON.parse(text) as JsonRpcResponse;
    }
    throw new Error(`server "${this.name}": unexpected content-type "${contentType}"`);
  }
}
