import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Windsurf (Codeium; being rebranded to "Devin Desktop").
 *
 * - User config root is the current ~/.codeium/windsurf (legacy: ~/.codeium;
 *   the older mcp_config.json location ~/.codeium/mcp_config.json is not
 *   written by this adapter).
 * - MCP: user scope only — no project-scope MCP file is documented, so
 *   project-scope MCP servers analyze as "degraded". Remote entries use the
 *   unusual `serverUrl` key (docs list it first; `url` is accepted on import).
 * - Instructions: legacy single file .windsurfrules at the workspace root
 *   (still read; the post-rebrand preference is .devin/rules/*.md, a
 *   directory of one-rule-per-file docs that the single-file factory does not
 *   target) and ~/.codeium/windsurf/memories/global_rules.md (6,000 char
 *   limit enforced by the product, not by AgentPack).
 * - Hooks: <configRoot>/hooks.json. Windsurf's native events are snake_case
 *   (pre_run_command, pre_user_prompt, ...) with different semantics from the
 *   canonical events; a precise event mapping is future work (MVP emits
 *   canonical event names).
 */
export const windsurfAdapter: TargetAdapter = defineSimpleAdapter({
  id: "windsurf",
  executables: ["windsurf"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".codeium", "windsurf"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".windsurf"),
  skills: {
    user: (home) => path.join(home, ".codeium", "windsurf", "skills"),
    project: (root) => path.join(root, ".windsurf", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".codeium", "windsurf", "mcp_config.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) => buildServerValue(server, { envRef: "env", urlKey: "serverUrl" }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "env",
        urlKey: "serverUrl",
        defaultRemoteTransport: "http",
      }),
  },
  instructions: {
    projectFile: ".windsurfrules",
    userFile: "memories/global_rules.md",
  },
  hooks: { support: "hooksJson" },
});
