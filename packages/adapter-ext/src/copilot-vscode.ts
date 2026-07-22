import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import {
  buildServerValue,
  defineSimpleAdapter,
  parseNativeServer,
  vscodeUserDir,
} from "./factory.js";

/**
 * GitHub Copilot in VS Code (github.copilot / github.copilot-chat extensions;
 * detection is by the VS Code host binaries `code` / `code-insiders`). The
 * stable "Code" user-data dir is assumed — Insiders profiles live under
 * "Code - Insiders/User".
 *
 * - MCP: top-level key is "servers", NOT "mcpServers". User file
 *   <profile User>/mcp.json, project .vscode/mcp.json. stdio entries carry
 *   "type": "stdio" (may be omitted natively; emitted explicitly here) with
 *   command/args/env/cwd; remote entries are "http"/"sse" + url/headers. Env
 *   references use VS Code's `${env:VAR}` substitution syntax.
 * - Instructions: .github/copilot-instructions.md (AGENTS.md at the root is
 *   also honored, but the Copilot-specific file is the managed target).
 *   User-scope instructions are profile-dependent with no fixed path →
 *   unsupported.
 * - Skills: project .github/skills/, personal ~/.copilot/skills/.
 * - Hooks (preview): directory of *.json files under .github/hooks/ with
 *   PascalCase events — does not fit the single hooks.json pattern →
 *   unsupported for MVP.
 */
export const copilotVscodeAdapter: TargetAdapter = defineSimpleAdapter({
  id: "copilot-vscode",
  executables: ["code", "code-insiders"],
  userConfigRoot: (ctx) => vscodeUserDir(ctx),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".vscode"),
  skills: {
    user: (home) => path.join(home, ".copilot", "skills"),
    project: (root) => path.join(root, ".github", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(vscodeUserDir(ctx), "mcp.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".vscode", "mcp.json"),
    format: "json",
    topKey: ["servers"],
    serverValue: (server) =>
      buildServerValue(server, {
        envRef: "env",
        stdioType: "stdio",
        httpType: "http",
        sseType: "sse",
        cwd: true,
      }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "env",
        stdioType: "stdio",
        httpType: "http",
        sseType: "sse",
        cwd: true,
      }),
  },
  instructions: {
    projectFile: ".github/copilot-instructions.md",
  },
  hooks: { support: "unsupported" },
});
