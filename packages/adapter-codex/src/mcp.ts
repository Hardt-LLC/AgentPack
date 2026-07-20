import { renderEnvRecord, type CanonicalMcpServer, type EnvValue } from "@agentpack/schema";

function nonEmpty(record: Record<string, string> | undefined): Record<string, string> | undefined {
  return record && Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Map a canonical MCP server to its Codex `config.toml` table value
 * (the object stored at [mcp_servers.<name>]).
 */
export function canonicalToTomlValue(server: CanonicalMcpServer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (server.transport === "stdio") {
    out.command = server.command;
    if (server.args && server.args.length > 0) out.args = [...server.args];
    if (server.cwd) out.cwd = server.cwd;
    const env = nonEmpty(renderEnvRecord(server.env));
    if (env) out.env = env;
    if (server.passEnv && server.passEnv.length > 0) out.env_vars = [...server.passEnv];
  } else {
    out.url = server.url;
    const headers = nonEmpty(renderEnvRecord(server.headers));
    if (headers) out.http_headers = headers;
  }
  if (server.startupTimeoutMs !== undefined) out.startup_timeout_ms = server.startupTimeoutMs;
  if (server.toolTimeoutMs !== undefined) out.tool_timeout_ms = server.toolTimeoutMs;
  if (server.approval) out.approval_policy = server.approval.default;
  return out;
}

/**
 * Map a canonical MCP server to its `.mcp.json` entry inside a Codex plugin
 * bundle. Kept deliberately small so builds stay hermetic.
 */
export function canonicalToMcpJson(server: CanonicalMcpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    const out: Record<string, unknown> = { type: "stdio", command: server.command };
    if (server.args && server.args.length > 0) out.args = [...server.args];
    const env = nonEmpty(renderEnvRecord(server.env));
    if (env) out.env = env;
    return out;
  }
  const out: Record<string, unknown> = { type: server.transport, url: server.url };
  const headers = nonEmpty(renderEnvRecord(server.headers));
  if (headers) out.headers = headers;
  return out;
}

/* ------------------------------ Import ------------------------------ */

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Parse a rendered env string back into a canonical EnvValue. */
export function parseEnvString(raw: string): EnvValue {
  const exact = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  if (exact) return { fromEnv: exact[1]! };
  const refs = [...raw.matchAll(ENV_REF)].map((m) => m[1]!);
  if (refs.length > 0) return { template: raw, requiredEnv: refs };
  return { value: raw };
}

function parseEnvRecord(raw: unknown): Record<string, EnvValue> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, EnvValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = typeof value === "string" ? parseEnvString(value) : { value: String(value) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const KNOWN_STDIO_KEYS = new Set([
  "command",
  "args",
  "cwd",
  "env",
  "env_vars",
  "startup_timeout_ms",
  "tool_timeout_ms",
  "enabled",
  "approval_policy",
]);

const KNOWN_URL_KEYS = new Set([
  "url",
  "http_headers",
  "startup_timeout_ms",
  "tool_timeout_ms",
  "enabled",
  "approval_policy",
]);

export interface TomlImportResult {
  server: Omit<CanonicalMcpServer, "name">;
  /** Keys that have no canonical equivalent (e.g. experimental fields). */
  extras: Record<string, unknown>;
}

/** Map a parsed [mcp_servers.<name>] table back to a canonical server spec. */
export function tomlTableToCanonical(table: Record<string, unknown>): TomlImportResult {
  const isStdio = typeof table.command === "string";
  const known = isStdio ? KNOWN_STDIO_KEYS : KNOWN_URL_KEYS;
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    if (!known.has(key)) extras[key] = value;
  }

  const server: Omit<CanonicalMcpServer, "name"> = {
    transport: isStdio ? "stdio" : "http",
    enabled: table.enabled !== false,
  };
  if (isStdio) {
    server.command = table.command as string;
    if (Array.isArray(table.args)) server.args = table.args.map(String);
    if (typeof table.cwd === "string") server.cwd = table.cwd;
    const env = parseEnvRecord(table.env);
    if (env) server.env = env;
    if (Array.isArray(table.env_vars)) server.passEnv = table.env_vars.map(String);
  } else {
    server.url = typeof table.url === "string" ? table.url : "";
    const headers = parseEnvRecord(table.http_headers);
    if (headers) server.headers = headers;
  }
  if (typeof table.startup_timeout_ms === "number") {
    server.startupTimeoutMs = table.startup_timeout_ms;
  }
  if (typeof table.tool_timeout_ms === "number") {
    server.toolTimeoutMs = table.tool_timeout_ms;
  }
  const approval = table.approval_policy;
  if (approval === "prompt" || approval === "always" || approval === "never") {
    server.approval = { default: approval };
  } else if (approval !== undefined) {
    extras.approval_policy = approval;
  }
  return { server, extras };
}
