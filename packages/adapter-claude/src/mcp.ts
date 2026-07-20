import { renderEnvRecord, type CanonicalMcpServer, type EnvValue } from "@agentpack/schema";

/* ------------------------- Native rendering ------------------------- */

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function mcpServerPointer(name: string): string {
  return `/mcpServers/${escapeJsonPointerSegment(name)}`;
}

/**
 * Render a canonical MCP server to the Claude .mcp.json value shape.
 * Deterministic key order: type, command, args, cwd, env, url, headers,
 * startupTimeoutMs, timeout. Env/headers are rendered as "${VAR}" references
 * and never resolved. passEnv / approval / allowTools / denyTools have no
 * Claude equivalent and are intentionally dropped (analyze reports them).
 */
export function claudeMcpServerValue(server: CanonicalMcpServer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.type = server.transport;
  if (server.transport === "stdio") {
    out.command = server.command;
    if (server.args && server.args.length > 0) out.args = [...server.args];
    if (server.cwd) out.cwd = server.cwd;
    const env = renderEnvRecord(server.env);
    if (env && Object.keys(env).length > 0) out.env = env;
  } else {
    out.url = server.url;
    const headers = renderEnvRecord(server.headers);
    if (headers && Object.keys(headers).length > 0) out.headers = headers;
  }
  if (server.startupTimeoutMs !== undefined) out.startupTimeoutMs = server.startupTimeoutMs;
  if (server.toolTimeoutMs !== undefined) out.timeout = server.toolTimeoutMs;
  return out;
}

/* --------------------------- Import parsing -------------------------- */

const EXACT_ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Map a native env/headers string back to a canonical EnvValue. */
export function parseEnvString(raw: string): EnvValue {
  const exact = EXACT_ENV_REF.exec(raw);
  if (exact) return { fromEnv: exact[1]! };
  const refs = [...raw.matchAll(ENV_REF)].map((m) => m[1]!);
  if (refs.length > 0) return { template: raw, requiredEnv: [...new Set(refs)] };
  return { value: raw };
}

function parseEnvRecord(raw: unknown): Record<string, EnvValue> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, EnvValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = parseEnvString(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const KNOWN_SERVER_KEYS = new Set([
  "type",
  "command",
  "args",
  "cwd",
  "env",
  "url",
  "headers",
  "startupTimeoutMs",
  "timeout",
]);

/**
 * Map a native .mcp.json server entry to a canonical server spec. Unknown keys
 * are preserved under `extensions`.
 */
export function importMcpServer(raw: Record<string, unknown>): Omit<CanonicalMcpServer, "name"> {
  const type = raw.type;
  let transport: "stdio" | "http" | "sse";
  if (type === "stdio" || type === "http" || type === "sse") {
    transport = type;
  } else {
    transport = typeof raw.command === "string" ? "stdio" : "http";
  }

  const server: Omit<CanonicalMcpServer, "name"> = { transport, enabled: true };
  if (transport === "stdio") {
    if (typeof raw.command === "string") server.command = raw.command;
    if (Array.isArray(raw.args)) {
      const args = raw.args.filter((a): a is string => typeof a === "string");
      if (args.length > 0) server.args = args;
    }
    if (typeof raw.cwd === "string") server.cwd = raw.cwd;
    const env = parseEnvRecord(raw.env);
    if (env) server.env = env;
  } else {
    if (typeof raw.url === "string") server.url = raw.url;
    const headers = parseEnvRecord(raw.headers);
    if (headers) server.headers = headers;
  }
  if (typeof raw.startupTimeoutMs === "number") server.startupTimeoutMs = raw.startupTimeoutMs;
  if (typeof raw.timeout === "number") server.toolTimeoutMs = raw.timeout;

  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_SERVER_KEYS.has(key)) extensions[key] = value;
  }
  if (Object.keys(extensions).length > 0) server.extensions = extensions;
  return server;
}
