import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Cline (VS Code extension `saoudrizwan.claude-dev` + `cline` CLI).
 *
 * - MCP: ~/.cline/data/settings/cline_mcp_settings.json. The docs are
 *   inconsistent (the CLI page also documents ~/.cline/mcp.json); the
 *   config-layout page marks data/settings/cline_mcp_settings.json as shared
 *   by IDE/CLI/SDK, so it is authoritative here. CLINE_DATA_DIR relocates the
 *   data/ directory only (skills/rules stay under ~/.cline), so it is honored
 *   in the MCP path rather than as a config-root override. No project-scope
 *   MCP file is documented → project-scope MCP analyzes as "degraded".
 * - Remote entries require an explicit type: "streamableHttp" (camelCase) for
 *   http, "sse" for legacy SSE; a typeless URL entry defaults to legacy SSE
 *   on import.
 * - Env interpolation syntax is not pinned down by the data sheet; the
 *   Roo/Cline-family `${env:VAR}` convention is used.
 * - Instructions: single .clinerules file at the workspace root (a
 *   .clinerules/ directory also works but is not the single-file target) and
 *   ~/.cline/rules/default.md (the rules directory also loads ~/Documents/
 *   Cline/Rules on some platforms; not written here).
 * - Hooks: Cline has directory-discovered executable hook scripts with no
 *   JSON manifest — reported unsupported for MVP.
 */
export const clineAdapter: TargetAdapter = defineSimpleAdapter({
  id: "cline",
  executables: ["cline"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".cline"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".cline"),
  skills: {
    user: (home) => path.join(home, ".cline", "skills"),
    project: (root) => path.join(root, ".cline", "skills"),
  },
  mcp: {
    user: (ctx) =>
      path.join(
        ctx.env.CLINE_DATA_DIR ?? path.join(ctx.homeDir, ".cline", "data"),
        "settings",
        "cline_mcp_settings.json",
      ),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) =>
      buildServerValue(server, { envRef: "env", httpType: "streamableHttp", sseType: "sse" }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "env",
        httpType: "streamableHttp",
        sseType: "sse",
        defaultRemoteTransport: "sse",
      }),
  },
  instructions: {
    projectFile: ".clinerules",
    userFile: "rules/default.md",
  },
  hooks: { support: "unsupported" },
});
