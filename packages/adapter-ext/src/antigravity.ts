import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Google Antigravity (agent-first app / IDE / CLI flavors). All paths are
 * community-verified (official docs are JS-rendered); the sheet warns the
 * project dir is .agents/ in current builds (legacy: .agent/, detected but
 * not written).
 *
 * - User config root is ~/.gemini/config (shared ~/.gemini tree with Gemini
 *   CLI); the flavor state dirs under ~/.gemini (antigravity, antigravity-cli,
 *   antigravity-ide) count as extra detection signals.
 * - MCP: top key "mcpServers" in ~/.gemini/config/mcp_config.json and
 *   .agents/mcp_config.json. stdio entries are {command,args,env?} with no
 *   "type"; remote entries use "serverUrl" ONLY (url/httpUrl are rejected by
 *   the product). Env interpolation is not documented — plain `${VAR}` is
 *   emitted.
 * - Instructions: global ~/.gemini/GEMINI.md — one level ABOVE the config
 *   root, hence the "../GEMINI.md" userFile (path.join normalizes it).
 *   Workspace rules are a directory (.agents/rules/*.md); the managed file
 *   inside it is .agents/rules/agentpack.md.
 * - Skills: .agents/skills/ and ~/.gemini/config/skills/ (the only global
 *   location honored by all three flavors).
 * - Hooks: .agents/hooks.json / ~/.gemini/config/hooks.json exist, but tool
 *   events wrap entries in {matcher, hooks:[...]} — not the flat hooks.json
 *   pattern → unsupported for MVP.
 */
export const antigravityAdapter: TargetAdapter = defineSimpleAdapter({
  id: "antigravity",
  executables: ["antigravity"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".gemini", "config"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".agents"),
  extraDetectionPaths: (ctx) => [
    path.join(ctx.homeDir, ".gemini", "antigravity"),
    path.join(ctx.homeDir, ".gemini", "antigravity-cli"),
    path.join(ctx.homeDir, ".gemini", "antigravity-ide"),
    // Legacy project dir from older builds.
    path.join(ctx.projectRoot, ".agent"),
  ],
  skills: {
    user: (home) => path.join(home, ".gemini", "config", "skills"),
    project: (root) => path.join(root, ".agents", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".gemini", "config", "mcp_config.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".agents", "mcp_config.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) => buildServerValue(server, { envRef: "plain", urlKey: "serverUrl" }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "plain",
        urlKey: "serverUrl",
        defaultRemoteTransport: "http",
      }),
  },
  instructions: {
    projectFile: ".agents/rules/agentpack.md",
    userFile: "../GEMINI.md",
  },
  hooks: { support: "unsupported" },
});
