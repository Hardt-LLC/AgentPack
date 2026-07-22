import path from "node:path";

import type { TargetAdapter } from "@agentpack/schema";

import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "./factory.js";

/**
 * Hermes Agent (NousResearch).
 *
 * - MCP: top-level "mcp_servers" key (snake_case) inside
 *   $HERMES_HOME/config.yaml — the YAML case mergeYaml was built for.
 *   Transports are implicit: presence of command = stdio, url = HTTP; env
 *   references use ${VAR} (config.yaml supports ${VAR} substitution).
 * - No project config file exists → project-scope MCP analyzes as
 *   "degraded". The projectConfigRoot is set to the .hermes.md context file
 *   purely as a project detection hint.
 * - Instructions: project context file .hermes.md (AGENTS.md/CLAUDE.md are
 *   also auto-read, but .hermes.md is the tool-specific one). The global
 *   SOUL.md is the agent's identity slot, NOT managed by AgentPack →
 *   user-scope instructions unsupported.
 * - Skills: ~/.hermes/skills/ only (no project skills dir documented).
 * - Hooks: none documented → unsupported.
 */
export const hermesAdapter: TargetAdapter = defineSimpleAdapter({
  id: "hermes",
  executables: ["hermes"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".hermes"),
  // Hermes has no project config root; the context file doubles as a hint.
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".hermes.md"),
  envOverride: "HERMES_HOME",
  skills: {
    user: (home, env) => path.join(env.HERMES_HOME || path.join(home, ".hermes"), "skills"),
  },
  mcp: {
    user: (ctx) =>
      path.join(ctx.env.HERMES_HOME || path.join(ctx.homeDir, ".hermes"), "config.yaml"),
    format: "yaml",
    topKey: ["mcp_servers"],
    serverValue: (server) => buildServerValue(server, { envRef: "plain" }),
    parseServer: (name, raw) =>
      parseNativeServer(name, raw, { envRef: "plain", defaultRemoteTransport: "http" }),
  },
  instructions: {
    projectFile: ".hermes.md",
  },
  hooks: { support: "unsupported" },
});
