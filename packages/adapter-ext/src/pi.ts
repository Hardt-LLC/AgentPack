import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Pi (badlogic, pi-mono).
 *
 * - MCP has no core support; this adapter targets the pi-mcp-adapter /
 *   pi-mcp-extension files: user $PI_CODING_AGENT_DIR/mcp.json (default
 *   ~/.pi/agent/mcp.json), project .mcp.json (the portable choice; the
 *   adapter also reads .pi/mcp.json but .mcp.json is what we write).
 *   Standard mcpServers shape: stdio command/args/env/cwd, remote
 *   url/headers, ${VAR} interpolation.
 * - Instructions: AGENTS.md — loaded from cwd, parent directories and
 *   ~/.pi/agent/AGENTS.md.
 * - Skills: ~/.pi/agent/skills/ and .pi/skills/ (Claude Code format).
 * - Hooks: TypeScript extensions only, no declarative config → unsupported.
 */
export const piAdapter: TargetAdapter = defineSimpleAdapter({
  id: "pi",
  executables: ["pi"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".pi", "agent"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".pi"),
  envOverride: "PI_CODING_AGENT_DIR",
  skills: {
    user: (home, env) =>
      path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "skills"),
    project: (root) => path.join(root, ".pi", "skills"),
  },
  mcp: {
    user: (ctx) =>
      path.join(ctx.env.PI_CODING_AGENT_DIR || path.join(ctx.homeDir, ".pi", "agent"), "mcp.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".mcp.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) => buildServerValue(server, { envRef: "plain", cwd: true }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "plain",
        cwd: true,
        defaultRemoteTransport: "http",
      }),
  },
  instructions: {
    projectFile: "AGENTS.md",
    userFile: "AGENTS.md",
    directoryFile: (dir) => `${dir}/AGENTS.md`,
  },
  hooks: { support: "unsupported" },
});
