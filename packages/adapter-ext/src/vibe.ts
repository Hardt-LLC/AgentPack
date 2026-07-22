import path from "node:path";

import type { CanonicalMcpServer, TargetAdapter } from "@agentpack/schema";

import { defineSimpleAdapter, parseNativeServer, renderEnv } from "./factory.js";

/**
 * Native config.toml MCP entry (Mistral Vibe). Emitted as an inline table at
 * [mcp_servers.<name>] rather than the canonical [[mcp_servers]] array of
 * tables — see the adapter comment below. transport is explicit:
 * stdio | http | streamable-http. Canonical "http" maps to "streamable-http"
 * (the example remote in the sheet); canonical "sse" has no vibe equivalent
 * and degrades to "http". stdio command stays a string.
 */
function vibeServerValue(server: CanonicalMcpServer): Record<string, unknown> {
  const out: Record<string, unknown> = { name: server.name };
  if (server.transport === "stdio") {
    out.transport = "stdio";
    out.command = server.command;
    if (server.args) out.args = server.args;
    const env = renderEnv(server.env, "plain");
    if (env) out.env = env;
  } else {
    out.transport = server.transport === "http" ? "streamable-http" : "http";
    out.url = server.url;
    const headers = renderEnv(server.headers, "plain");
    if (headers) out.headers = headers;
  }
  return out;
}

/**
 * Mistral Vibe.
 *
 * - MCP: [[mcp_servers]] array of tables in config.toml (user
 *   $VIBE_HOME/config.toml, project ./.vibe/config.toml). mergeTomlAtTable
 *   addresses table paths, not array entries, so servers are written as
 *   [mcp_servers.<name>] inline tables — TOML parsers read both, and the
 *   entry keeps its `name` field for compatibility with the array form.
 *   Import reads BOTH forms (the factory's import also iterates arrays of
 *   tables with a name field).
 * - Instructions: AGENTS.md in the project and at $VIBE_HOME/AGENTS.md.
 * - Skills: ~/.vibe/skills/ and .vibe/skills/ (VIBE_HOME honored).
 * - Hooks: experimental hooks.toml with only three events → unsupported.
 */
export const vibeAdapter: TargetAdapter = defineSimpleAdapter({
  id: "vibe",
  executables: ["vibe"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".vibe"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".vibe"),
  envOverride: "VIBE_HOME",
  skills: {
    user: (home, env) => path.join(env.VIBE_HOME || path.join(home, ".vibe"), "skills"),
    project: (root) => path.join(root, ".vibe", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.env.VIBE_HOME || path.join(ctx.homeDir, ".vibe"), "config.toml"),
    project: (ctx) => path.join(ctx.projectRoot, ".vibe", "config.toml"),
    format: "toml",
    topKey: ["mcp_servers"],
    serverValue: vibeServerValue,
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "plain",
        transportKey: "transport",
        httpType: "streamable-http",
        sseType: "sse",
        defaultRemoteTransport: "http",
      }),
  },
  instructions: {
    projectFile: "AGENTS.md",
    userFile: "AGENTS.md",
  },
  hooks: { support: "unsupported" },
});
