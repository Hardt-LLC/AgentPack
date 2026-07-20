import { readFile } from "node:fs/promises";

export interface GatewayServerConfig {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  passEnv?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  allowTools?: string[];
  denyTools?: string[];
}

export interface GatewayConfig {
  version: 1;
  servers: Record<string, GatewayServerConfig>;
}

export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
export const GATEWAY_NAME = "agentpack-gateway";
export const GATEWAY_VERSION = "0.1.0";

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  server: string,
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new GatewayConfigError(`server "${server}": "${key}" must be a string`);
  }
  return value;
}

function optionalStringArray(
  server: string,
  raw: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GatewayConfigError(`server "${server}": "${key}" must be an array of strings`);
  }
  return value as string[];
}

function optionalStringRecord(
  server: string,
  raw: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new GatewayConfigError(
      `server "${server}": "${key}" must be an object with string values`,
    );
  }
  return value as Record<string, string>;
}

function optionalTimeout(
  server: string,
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new GatewayConfigError(`server "${server}": "${key}" must be a positive number`);
  }
  return value;
}

function validateServer(name: string, raw: unknown): GatewayServerConfig {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new GatewayConfigError(
      `invalid server name "${name}": must match ${SERVER_NAME_PATTERN.source}`,
    );
  }
  if (!isRecord(raw)) {
    throw new GatewayConfigError(`server "${name}": config must be an object`);
  }
  const transport = raw["transport"];
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new GatewayConfigError(`server "${name}": "transport" must be "stdio", "http", or "sse"`);
  }
  const command = optionalString(name, raw, "command");
  const url = optionalString(name, raw, "url");
  if (transport === "stdio" && command === undefined) {
    throw new GatewayConfigError(`server "${name}": stdio transport requires "command"`);
  }
  if (transport !== "stdio" && url === undefined) {
    throw new GatewayConfigError(`server "${name}": ${transport} transport requires "url"`);
  }
  const args = optionalStringArray(name, raw, "args");
  const cwd = optionalString(name, raw, "cwd");
  const headers = optionalStringRecord(name, raw, "headers");
  const env = optionalStringRecord(name, raw, "env");
  const passEnv = optionalStringArray(name, raw, "passEnv");
  const allowTools = optionalStringArray(name, raw, "allowTools");
  const denyTools = optionalStringArray(name, raw, "denyTools");
  return {
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(passEnv !== undefined ? { passEnv } : {}),
    startupTimeoutMs: optionalTimeout(name, raw, "startupTimeoutMs", DEFAULT_STARTUP_TIMEOUT_MS),
    toolTimeoutMs: optionalTimeout(name, raw, "toolTimeoutMs", DEFAULT_TOOL_TIMEOUT_MS),
    ...(allowTools !== undefined ? { allowTools } : {}),
    ...(denyTools !== undefined ? { denyTools } : {}),
  };
}

export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new GatewayConfigError(
      `cannot read gateway config at ${path}: ${(err as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GatewayConfigError(
      `invalid JSON in gateway config at ${path}: ${(err as Error).message}`,
    );
  }
  if (!isRecord(raw)) {
    throw new GatewayConfigError(`gateway config at ${path}: top level must be an object`);
  }
  if (raw["version"] !== 1) {
    throw new GatewayConfigError(`gateway config at ${path}: "version" must be 1`);
  }
  if (!isRecord(raw["servers"])) {
    throw new GatewayConfigError(`gateway config at ${path}: "servers" must be an object`);
  }
  const servers: Record<string, GatewayServerConfig> = {};
  for (const [name, serverRaw] of Object.entries(raw["servers"])) {
    servers[name] = validateServer(name, serverRaw);
  }
  return { version: 1, servers };
}

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface ResolvedEnvTemplates {
  resolved: Record<string, string>;
  missing: string[];
}

/**
 * Resolves ${VAR} placeholders in string values against the gateway's own
 * process environment. Missing variables are reported, never thrown.
 */
export function resolveEnvTemplates(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnvTemplates {
  const resolved: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [key, template] of Object.entries(record ?? {})) {
    resolved[key] = template.replace(PLACEHOLDER_PATTERN, (_match, varName: string) => {
      const value = env[varName];
      if (value === undefined) {
        missing.add(varName);
        return "";
      }
      return value;
    });
  }
  return { resolved, missing: [...missing] };
}
