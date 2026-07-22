import path from "node:path";

import type { CanonicalMcpServer, TargetAdapter } from "@agentpack/schema";

import { defineSimpleAdapter, envRecordFromNative, renderEnv } from "./factory.js";

/**
 * Native opencode.json MCP entry: stdio is
 * { type: "local", command: [...], environment? } with the command as an
 * ARRAY; remote is { type: "remote", url, headers? }. Env/file substitution
 * uses `{env:VAR}` / `{file:path}` (documented).
 */
function opencodeServerValue(server: CanonicalMcpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    const out: Record<string, unknown> = {
      type: "local",
      command: [server.command!, ...(server.args ?? [])],
    };
    const environment = renderEnv(server.env, "brace");
    if (environment) out.environment = environment;
    return out;
  }
  const out: Record<string, unknown> = { type: "remote", url: server.url };
  const headers = renderEnv(server.headers, "brace");
  if (headers) out.headers = headers;
  return out;
}

function parseOpencodeServer(
  name: string,
  raw: unknown,
): Omit<CanonicalMcpServer, "name"> | undefined {
  void name;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === false ? false : true;

  if (
    record.type === "local" &&
    Array.isArray(record.command) &&
    record.command.length > 0 &&
    record.command.every((part) => typeof part === "string")
  ) {
    const [command, ...args] = record.command as string[];
    const spec: Record<string, unknown> = { transport: "stdio", command, enabled };
    if (args.length > 0) spec.args = args;
    const environment = envRecordFromNative(record.environment);
    if (environment) spec.env = environment;
    return spec as Omit<CanonicalMcpServer, "name">;
  }

  if (record.type === "remote" && typeof record.url === "string" && record.url.length > 0) {
    const spec: Record<string, unknown> = { transport: "http", url: record.url, enabled };
    const headers = envRecordFromNative(record.headers);
    if (headers) spec.headers = headers;
    return spec as Omit<CanonicalMcpServer, "name">;
  }

  return undefined;
}

/**
 * OpenCode (sst/opencode).
 *
 * - MCP: top-level "mcp" key (NOT mcpServers) in ~/.config/opencode/
 *   opencode.json and project opencode.json. Only "local"/"remote" types;
 *   local command is an array, env key is "environment".
 * - Format: "json" — opencode.json also accepts JSONC, but strict JSON is
 *   always valid input while YAML-styled merge output would not be; the
 *   trade-off is that importing a JSONC file with comments fails with a
 *   warning (degraded import, safe writes).
 * - Instructions: AGENTS.md (project + subdirectories). There is no
 *   documented auto-loaded global instructions file (extra files are wired
 *   via the config's instructions[] array) → user-scope instructions
 *   unsupported.
 * - Skills: no dedicated skills concept (agents/commands/plugins instead) →
 *   unsupported.
 * - Hooks: implemented via JS/TS plugins only → unsupported.
 */
export const opencodeAdapter: TargetAdapter = defineSimpleAdapter({
  id: "opencode",
  executables: ["opencode"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".config", "opencode"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".opencode"),
  skillsUnsupportedRemediation:
    "OpenCode has no skills directory (use agents/commands/plugins instead)",
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".config", "opencode", "opencode.json"),
    project: (ctx) => path.join(ctx.projectRoot, "opencode.json"),
    format: "json",
    topKey: ["mcp"],
    serverValue: opencodeServerValue,
    parseServer: parseOpencodeServer,
  },
  instructions: {
    projectFile: "AGENTS.md",
    directoryFile: (dir) => `${dir}/AGENTS.md`,
  },
  hooks: { support: "unsupported" },
});
