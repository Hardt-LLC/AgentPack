import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Gemini CLI (google-gemini/gemini-cli).
 *
 * - MCP lives inside settings.json (no separate file): user
 *   ~/.gemini/settings.json, project <project>/.gemini/settings.json, top key
 *   "mcpServers". Transport is inferred from which key is present — stdio
 *   entries are {command,args,env,cwd?} with NO "type" key; HTTP uses
 *   "httpUrl", SSE uses "url". Env references use the plain `${VAR}` syntax
 *   ($VAR and ${VAR:-default} also supported natively; ${VAR} is emitted).
 * - Instructions: GEMINI.md at the project root (hierarchical — subdirectory
 *   GEMINI.md files also load) and ~/.gemini/GEMINI.md globally.
 * - Skills: .gemini/skills/ and ~/.gemini/skills/.
 * - Hooks: configured inline under a top-level "hooks" key in settings.json
 *   with a nested {matcher, hooks:[...]} shape — not the flat hooks.json
 *   pattern → unsupported for MVP.
 */
export const geminiAdapter: TargetAdapter = defineSimpleAdapter({
  id: "gemini",
  executables: ["gemini"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".gemini"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".gemini"),
  skills: {
    user: (home) => path.join(home, ".gemini", "skills"),
    project: (root) => path.join(root, ".gemini", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".gemini", "settings.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".gemini", "settings.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) =>
      buildServerValue(server, { envRef: "plain", httpUrlKey: "httpUrl", cwd: true }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "plain",
        httpUrlKey: "httpUrl",
        cwd: true,
        defaultRemoteTransport: "sse",
      }),
  },
  instructions: {
    projectFile: "GEMINI.md",
    userFile: "GEMINI.md",
    directoryFile: (dir) => `${dir}/GEMINI.md`,
  },
  hooks: { support: "unsupported" },
});
