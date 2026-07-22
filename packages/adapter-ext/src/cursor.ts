import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Cursor (cursor.com editor + `agent` CLI; older CLI name: `cursor-agent`).
 *
 * - MCP: common `mcpServers` mcp.json at ~/.cursor and <project>/.cursor.
 *   stdio entries are { command, args, env, cwd? } with no "type" key; remote
 *   entries are { url, headers? } (url selects HTTP/SSE). Env interpolation
 *   uses the `${env:VAR}` syntax per cursor.com/docs/mcp.
 * - Instructions: root-level AGENTS.md (also honored in subdirectories).
 *   Global rules live in the Cursor Settings UI with no documented file, so
 *   user-scope instructions are reported unsupported.
 * - Hooks: <configRoot>/hooks.json (flat array per event). Canonical event
 *   names match Cursor's for preToolUse/postToolUse/sessionStart/sessionEnd;
 *   userPromptSubmit maps to Cursor's beforeSubmitPrompt and notification has
 *   no Cursor equivalent — a precise event mapping is future work (MVP).
 */
export const cursorAdapter: TargetAdapter = defineSimpleAdapter({
  id: "cursor",
  executables: ["cursor", "agent"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".cursor"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".cursor"),
  skills: {
    user: (home) => path.join(home, ".cursor", "skills"),
    project: (root) => path.join(root, ".cursor", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".cursor", "mcp.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".cursor", "mcp.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) => buildServerValue(server, { envRef: "env", cwd: true }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "env",
        cwd: true,
        defaultRemoteTransport: "http",
      }),
  },
  instructions: {
    projectFile: "AGENTS.md",
    directoryFile: (dir) => `${dir}/AGENTS.md`,
  },
  hooks: { support: "hooksJson" },
});
