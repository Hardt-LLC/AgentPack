import type {
  AdapterContext,
  CanonicalPack,
  CapabilityFinding,
  CapabilityReport,
} from "@agentpack/schema";

import { readClaudeAgents } from "./agents.js";
import { normalizeMatcher, targetsIncludeClaude } from "./hooks.js";

const MATCHER_NORMALIZED_MESSAGE = "Matcher normalized to Claude tool names";

/**
 * Classify every component of the pack for Claude Code.
 *
 * MCP notes: passEnv, approval and allowTools/denyTools have no .mcp.json
 * representation — they yield additional "degraded" findings and are dropped
 * by generate(). Disabled servers are skipped entirely.
 */
export async function analyze(
  pack: CanonicalPack,
  _context: AdapterContext,
): Promise<CapabilityReport> {
  const findings: CapabilityFinding[] = [];
  const target = "claude" as const;

  for (const skill of pack.skills) {
    findings.push({ target, componentType: "skill", componentId: skill.name, support: "native" });
  }

  for (const server of Object.values(pack.mcpServers)) {
    if (server.enabled === false) continue;
    findings.push({ target, componentType: "mcp", componentId: server.name, support: "native" });
    if (server.passEnv && server.passEnv.length > 0) {
      findings.push({
        target,
        componentType: "mcp",
        componentId: server.name,
        support: "degraded",
        message: `passEnv (${server.passEnv.join(", ")}) cannot be represented in Claude .mcp.json and is dropped`,
        remediation:
          'declare each variable explicitly in env with { fromEnv: "VAR" } so it is rendered as a ${VAR} reference',
      });
    }
    if (server.approval) {
      findings.push({
        target,
        componentType: "mcp",
        componentId: server.name,
        support: "degraded",
        message: "approval policies are not representable in Claude .mcp.json and are dropped",
      });
    }
    if (
      (server.allowTools && server.allowTools.length > 0) ||
      (server.denyTools && server.denyTools.length > 0)
    ) {
      findings.push({
        target,
        componentType: "mcp",
        componentId: server.name,
        support: "degraded",
        message: "allowTools/denyTools are not representable in Claude .mcp.json and are dropped",
      });
    }
  }

  for (const instruction of pack.instructions) {
    if (!targetsIncludeClaude(instruction.targets)) continue;
    findings.push({
      target,
      componentType: "instruction",
      componentId: instruction.id,
      support: "native",
    });
  }

  if (pack.plugin?.enabled) {
    findings.push({
      target,
      componentType: "plugin",
      componentId: pack.metadata.name,
      support: "native",
    });
  }

  for (const hook of pack.hooks) {
    if (!targetsIncludeClaude(hook.targets)) continue;
    const { normalized } = normalizeMatcher(hook.matcher);
    findings.push({
      target,
      componentType: "hook",
      componentId: hook.id,
      support: normalized ? "transpiled" : "native",
      message: normalized ? MATCHER_NORMALIZED_MESSAGE : undefined,
    });
  }

  for (const agent of readClaudeAgents(pack)) {
    findings.push({ target, componentType: "agent", componentId: agent.name, support: "native" });
  }

  return { findings };
}
