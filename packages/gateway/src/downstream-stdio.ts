import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const BASE_ENV_KEYS = ["PATH", "HOME"];

export class StdioDownstream implements DownstreamClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private exited = false;
  private spawnFailed = false;

  constructor(
    readonly name: string,
    private readonly config: GatewayServerConfig,
    private readonly log: (msg: string) => void,
  ) {}

  async start(): Promise<McpTool[]> {
    try {
      return await this.startInner();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private async startInner(): Promise<McpTool[]> {
    if (this.config.command === undefined) {
      throw new Error(`server "${this.name}": stdio transport requires "command"`);
    }
    const { resolved, missing } = resolveEnvTemplates(this.config.env);
    if (missing.length > 0) {
      throw new Error(
        `server "${this.name}": missing environment variable(s): ${missing.join(", ")}`,
      );
    }
    const childEnv: Record<string, string> = {};
    for (const key of [...BASE_ENV_KEYS, ...(this.config.passEnv ?? [])]) {
      const value = process.env[key];
      if (value !== undefined) childEnv[key] = value;
    }
    Object.assign(childEnv, resolved);

    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd ?? process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderrData(chunk));
    child.on("error", (err) => {
      this.spawnFailed = true;
      this.failAll(new Error(`server "${this.name}": failed to spawn: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.failAll(
        new Error(
          `server "${this.name}": process exited (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
    });

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
    this.notify("notifications/initialized");
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
    const child = this.child;
    this.failAll(new Error(`server "${this.name}": stopped`));
    if (child === undefined || this.exited || this.spawnFailed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private notify(method: string): void {
    this.writeLine({ jsonrpc: "2.0", method });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.exited || this.spawnFailed) {
        reject(new Error(`server "${this.name}": process is not running`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`server "${this.name}": request "${method}" timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine({ jsonrpc: "2.0", id, method, params });
    });
  }

  private writeLine(message: Record<string, unknown>): void {
    const child = this.child;
    if (child === undefined) return;
    try {
      child.stdin.write(JSON.stringify(message) + "\n");
    } catch (err) {
      this.failAll(
        new Error(`server "${this.name}": stdin write failed: ${(err as Error).message}`),
      );
    }
  }

  private onStdoutData(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.log(`gateway: server "${this.name}" sent a malformed line, ignoring`);
      return;
    }
    if (typeof message.id !== "number") {
      // Downstream notification — nothing to do.
      return;
    }
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      const text =
        typeof message.error.message === "string" ? message.error.message : "downstream error";
      entry.reject(new Error(`server "${this.name}": ${redactSecrets(text)}`));
      return;
    }
    entry.resolve(message.result);
  }

  private onStderrData(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString("utf8");
    let newline = this.stderrBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stderrBuffer.slice(0, newline).trimEnd();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line.length > 0) this.log(`gateway: [${this.name}] ${redactSecrets(line)}`);
      newline = this.stderrBuffer.indexOf("\n");
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
