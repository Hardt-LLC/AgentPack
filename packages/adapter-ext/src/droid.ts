import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Factory Droid.
 *
 * - MCP: dedicated mcp.json (separate from settings.json) at ~/.factory and
 *   .factory, standard top-level "mcpServers". Explicit types
 *   stdio|http|sse (stdio is omittable natively; emitted explicitly here).
 *   ${VAR} / ${VAR:-default} expansion in env/headers → plain refs.
 *   (MCP layering is user > folder > project — user wins; we write user and
 *   project scopes only.)
 * - Instructions: AGENTS.md at the repo root (and nested). No documented
 *   user-scope instructions file → unsupported at user scope.
 * - Skills: ~/.factory/skills/ and .factory/skills/ (community-verified per
 *   the sheet).
 * - Hooks: ~/.factory/hooks.json exists but uses the Claude-Code nested
 *   shape ({matcher, hooks:[...]} per event, PascalCase events) — not the
 *   flat-array hooks.json pattern → unsupported for MVP.
 */
export const droidAdapter: TargetAdapter = defineSimpleAdapter({
  id: "droid",
  executables: ["droid"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".factory"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".factory"),
  skills: {
    user: (home) => path.join(home, ".factory", "skills"),
    project: (root) => path.join(root, ".factory", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".factory", "mcp.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".factory", "mcp.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) =>
      buildServerValue(server, {
        envRef: "plain",
        stdioType: "stdio",
        httpType: "http",
        sseType: "sse",
      }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "plain",
        stdioType: "stdio",
        httpType: "http",
        sseType: "sse",
        defaultRemoteTransport: "http",
      }),
  },
  instructions: {
    projectFile: "AGENTS.md",
    directoryFile: (dir) => `${dir}/AGENTS.md`,
  },
  hooks: { support: "unsupported" },
});
