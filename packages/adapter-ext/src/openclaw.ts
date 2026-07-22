import path from "node:path";

import type { CanonicalMcpServer, TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer, renderEnv } from "./factory.js";

/**
 * Native openclaw.json MCP entry: stdio {command,args,env,cwd?} with no
 * transport key; remote {url, transport: "streamable-http"|"sse", headers?}
 * (an omitted transport defaults to "sse" per the sheet).
 */
function openclawServerValue(server: CanonicalMcpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return buildServerValue(server, { envRef: "plain", cwd: true });
  }
  const out: Record<string, unknown> = {
    url: server.url,
    transport: server.transport === "http" ? "streamable-http" : "sse",
  };
  const headers = renderEnv(server.headers, "plain");
  if (headers) out.headers = headers;
  return out;
}

/**
 * OpenClaw.
 *
 * - MCP: nested mcp.servers (NOT top-level mcpServers) inside
 *   ~/.openclaw/openclaw.json. There is no per-project config file →
 *   project-scope MCP analyzes as "degraded".
 * - Format: "json". openclaw.json is JSON5 (comments/trailing commas), but
 *   strict JSON is valid JSON5 while YAML-styled merge output is not — so
 *   writes stay strict JSON and importing a file that uses JSON5-only syntax
 *   fails with a warning (degraded import, safe writes).
 * - Instructions: bootstrap AGENTS.md lives in the agent workspace, whose
 *   default is ~/.openclaw/workspace (customizable via
 *   agents.defaults.workspace — a custom workspace will not receive managed
 *   sections). Project-scope instructions: unsupported (no per-project
 *   config).
 * - Skills: ~/.openclaw/skills only (workspace tier is not a fixed path).
 * - Hooks: webhook ingress + plugin lifecycle hooks, no shell-command hook
 *   file → unsupported.
 */
export const openclawAdapter: TargetAdapter = defineSimpleAdapter({
  id: "openclaw",
  executables: ["openclaw"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".openclaw"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".openclaw"),
  skills: {
    user: (home) => path.join(home, ".openclaw", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".openclaw", "openclaw.json"),
    format: "json",
    topKey: ["mcp", "servers"],
    serverValue: openclawServerValue,
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "plain",
        transportKey: "transport",
        httpType: "streamable-http",
        sseType: "sse",
        cwd: true,
        defaultRemoteTransport: "sse",
      }),
  },
  instructions: {
    userFile: "workspace/AGENTS.md",
  },
  hooks: { support: "unsupported" },
});
