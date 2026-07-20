import {
  DEFAULT_PROTOCOL_VERSION,
  DEFAULT_TOOL_TIMEOUT_MS,
  GATEWAY_NAME,
  GATEWAY_VERSION,
  type GatewayConfig,
  type GatewayServerConfig,
} from "./config.js";
import {
  aggregateTools,
  parseToolName,
  type DownstreamClient,
  type McpTool,
  type RoutedTool,
} from "./aggregate.js";
import { StdioDownstream } from "./downstream-stdio.js";
import { HttpDownstream } from "./downstream-http.js";
import { redactSecrets } from "./redact.js";
import { runStdioLoop } from "./upstream.js";

export interface GatewayStatusEntry {
  name: string;
  state: "ok" | "degraded";
  tools: number;
  error?: string;
}

interface ServerEntry {
  name: string;
  config: GatewayServerConfig;
  client: DownstreamClient;
  state: "ok" | "degraded";
  tools: McpTool[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultResponse(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: string | number,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export class Gateway {
  private readonly entries: ServerEntry[] = [];
  private routed = new Map<string, RoutedTool>();
  private readonly log: (msg: string) => void;
  private started = false;

  constructor(
    private readonly config: GatewayConfig,
    opts?: { log?: (msg: string) => void },
  ) {
    this.log = opts?.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const client =
        serverConfig.transport === "stdio"
          ? new StdioDownstream(name, serverConfig, this.log)
          : new HttpDownstream(name, serverConfig, this.log);
      this.entries.push({ name, config: serverConfig, client, state: "degraded", tools: [] });
    }
  }

  /** Initializes all downstreams in parallel; failures degrade, never throw. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all(
      this.entries.map(async (entry) => {
        try {
          entry.tools = await entry.client.start();
          entry.state = "ok";
          this.log(`gateway: server "${entry.name}" ready (${entry.tools.length} tools)`);
        } catch (err) {
          entry.state = "degraded";
          entry.tools = [];
          entry.error = redactSecrets((err as Error).message);
          this.log(`gateway: server "${entry.name}" degraded: ${entry.error}`);
        }
      }),
    );
    this.routed = aggregateTools(
      this.entries
        .filter((entry) => entry.state === "ok")
        .map((entry) => ({
          server: entry.name,
          tools: entry.tools,
          ...(entry.config.allowTools !== undefined ? { allowTools: entry.config.allowTools } : {}),
          ...(entry.config.denyTools !== undefined ? { denyTools: entry.config.denyTools } : {}),
        })),
    );
  }

  /**
   * One JSON-RPC message in → response out (undefined for notifications).
   * Pure with respect to upstream I/O; safe to unit-test directly.
   */
  async handleMessage(msg: unknown): Promise<unknown | undefined> {
    if (!isRecord(msg)) return undefined;
    const rawId = msg["id"];
    const hasId = typeof rawId === "string" || typeof rawId === "number";
    const method = msg["method"];
    if (typeof method !== "string") {
      return hasId ? errorResponse(rawId as string | number, -32600, "Invalid Request") : undefined;
    }
    if (!hasId) return undefined;
    const id = rawId as string | number;
    switch (method) {
      case "initialize": {
        const params = isRecord(msg["params"]) ? msg["params"] : {};
        const protocolVersion =
          typeof params["protocolVersion"] === "string"
            ? params["protocolVersion"]
            : DEFAULT_PROTOCOL_VERSION;
        return resultResponse(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: GATEWAY_NAME, version: GATEWAY_VERSION },
        });
      }
      case "ping":
        return resultResponse(id, {});
      case "tools/list":
        return resultResponse(id, {
          tools: [...this.routed.values()].map((routedTool) => routedTool.exposed),
        });
      case "tools/call":
        return this.handleToolCall(id, msg["params"]);
      default:
        return errorResponse(id, -32601, "Method not found");
    }
  }

  private async handleToolCall(
    id: string | number,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    if (!isRecord(params) || typeof params["name"] !== "string") {
      return errorResponse(id, -32602, 'Invalid params: tools/call requires a string "name"');
    }
    const publicName = params["name"];
    const routedTool = this.routed.get(publicName);
    if (routedTool === undefined) {
      const parsed = parseToolName(publicName);
      const detail =
        parsed !== undefined && this.config.servers[parsed.server] === undefined
          ? `unknown server prefix "${parsed.server}"`
          : `unknown tool "${publicName}"`;
      return errorResponse(id, -32602, `Invalid params: ${detail}`);
    }
    const entry = this.entries.find((candidate) => candidate.name === routedTool.server);
    if (entry === undefined || entry.state !== "ok") {
      return errorResponse(id, -32602, `Invalid params: server "${routedTool.server}" is degraded`);
    }
    const timeoutMs = entry.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    try {
      const result = await entry.client.callTool(
        routedTool.toolName,
        params["arguments"],
        timeoutMs,
      );
      return resultResponse(id, result);
    } catch (err) {
      return errorResponse(id, -32603, redactSecrets((err as Error).message));
    }
  }

  /** Starts downstreams, serves NDJSON on stdin/stdout until stdin ends. */
  async run(): Promise<void> {
    await this.start();
    const shutdown = (signal: string): void => {
      this.log(`gateway: received ${signal}, shutting down`);
      void this.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    await runStdioLoop(this, { log: this.log });
    await this.stop();
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.entries.map(async (entry) => {
        try {
          await entry.client.stop();
        } catch (err) {
          this.log(`gateway: error stopping server "${entry.name}": ${(err as Error).message}`);
        }
      }),
    );
  }

  status(): GatewayStatusEntry[] {
    return this.entries.map((entry) => ({
      name: entry.name,
      state: entry.state,
      tools: entry.state === "ok" ? entry.tools.length : 0,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    }));
  }
}
