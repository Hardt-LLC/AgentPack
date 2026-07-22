import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import {
  buildServerValue,
  defineSimpleAdapter,
  parseNativeServer,
  vscodeGlobalStorage,
} from "./factory.js";

const ROO_EXTENSION_ID = "rooveterinaryinc.roo-cline";

/**
 * Roo Code (pure VS Code extension; no CLI binary — detection relies on the
 * extension's globalStorage directory and ~/.roo). Note: the project
 * announced archival in May 2026; Kilo Code is the maintained fork.
 *
 * - MCP: global mcp_settings.json inside the VS Code globalStorage (stable
 *   "Code" variant assumed; Insiders/VSCodium use different parent dirs) and
 *   project <project>/.roo/mcp.json. An explicit "type" is REQUIRED for any
 *   URL-based entry ("streamable-http" / "sse"); typeless URL entries are
 *   skipped on import. stdio entries also carry "type": "stdio" plus the
 *   richer schema's cwd when set. Env interpolation uses `${env:VAR}`.
 * - Skills: Roo Code has no skills directory — skills analyze as
 *   "unsupported".
 * - Instructions: legacy single files .roorules (workspace) and a managed
 *   file inside ~/.roo/rules/ (global; the directory loads any text file,
 *   recursively, alphabetically).
 * - Hooks: Roo Code has no lifecycle-hooks feature — unsupported.
 */
export const rooAdapter: TargetAdapter = defineSimpleAdapter({
  id: "roo",
  executables: [],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".roo"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".roo"),
  extraDetectionPaths: (ctx) => [vscodeGlobalStorage(ctx, ROO_EXTENSION_ID)],
  skillsUnsupportedRemediation: "Roo Code has no skills directory",
  mcp: {
    user: (ctx) =>
      path.join(vscodeGlobalStorage(ctx, ROO_EXTENSION_ID), "settings", "mcp_settings.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".roo", "mcp.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) =>
      buildServerValue(server, {
        envRef: "env",
        stdioType: "stdio",
        httpType: "streamable-http",
        sseType: "sse",
        cwd: true,
      }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "env",
        stdioType: "stdio",
        httpType: "streamable-http",
        sseType: "sse",
        cwd: true,
      }),
  },
  instructions: {
    projectFile: ".roorules",
    userFile: "rules/agentpack.md",
  },
  hooks: { support: "unsupported" },
  nativeSourcesPaths: (ctx) => [
    path.join(vscodeGlobalStorage(ctx, ROO_EXTENSION_ID), "settings", "mcp_settings.json"),
    path.join(ctx.homeDir, ".roo", "rules"),
  ],
});
