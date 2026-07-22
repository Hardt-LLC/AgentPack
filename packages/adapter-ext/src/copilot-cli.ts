import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * GitHub Copilot CLI (the `copilot` terminal agent; the legacy `gh copilot`
 * extension is a different, deprecated tool).
 *
 * - User root ~/.copilot, relocated by COPILOT_HOME (envOverride covers the
 *   config root and instruction file; the MCP path and skills dir honor it
 *   explicitly).
 * - MCP: user ~/.copilot/mcp-config.json, project .mcp.json (the cwd
 *   .copilot/mcp-config.json is NOT auto-loaded per the docs issue cited in
 *   the data sheet; .github/mcp.json also works but .mcp.json takes
 *   precedence). Top key "mcpServers"; "type" is required — "local" and
 *   "stdio" are equivalent and "stdio" is preferred for cross-client compat.
 *   The optional per-server "tools" array defaults to ["*"] natively and is
 *   not emitted. Env references use the `${env:VAR}` convention.
 * - Instructions: project .github/copilot-instructions.md, user
 *   ~/.copilot/copilot-instructions.md.
 * - Skills: user ~/.copilot/skills/; project .github/skills/ (the sheet only
 *   says "project-level skills" — the .github/ location mirrors the VS Code
 *   layout the CLI also reads; flagged as the ambiguous bit).
 * - Hooks: *.json files under ~/.copilot/hooks/ and .github/hooks/ (directory
 *   layout, not a single hooks.json) → unsupported for MVP.
 */
export const copilotCliAdapter: TargetAdapter = defineSimpleAdapter({
  id: "copilot-cli",
  executables: ["copilot"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".copilot"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".github", "copilot"),
  envOverride: "COPILOT_HOME",
  skills: {
    user: (home, env) => path.join(env.COPILOT_HOME || path.join(home, ".copilot"), "skills"),
    project: (root) => path.join(root, ".github", "skills"),
  },
  mcp: {
    user: (ctx) =>
      path.join(ctx.env.COPILOT_HOME || path.join(ctx.homeDir, ".copilot"), "mcp-config.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".mcp.json"),
    format: "json",
    topKey: ["mcpServers"],
    serverValue: (server) =>
      buildServerValue(server, {
        envRef: "env",
        stdioType: "stdio",
        httpType: "http",
        sseType: "sse",
      }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, {
        envRef: "env",
        stdioType: "stdio",
        httpType: "http",
        sseType: "sse",
      }),
  },
  instructions: {
    projectFile: ".github/copilot-instructions.md",
    userFile: "copilot-instructions.md",
  },
  hooks: { support: "unsupported" },
});
