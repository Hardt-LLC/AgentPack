import type {
  AdapterContext,
  CanonicalPack,
  CapabilityFinding,
  CapabilityReport,
} from "@agentpack/schema";

import { targetsKimi } from "./util.js";

/** Classify every component of the pack for Kimi Code. */
export async function analyzeKimi(
  pack: CanonicalPack,
  _context: AdapterContext,
): Promise<CapabilityReport> {
  const findings: CapabilityFinding[] = [];

  for (const skill of pack.skills) {
    findings.push({
      target: "kimi",
      componentType: "skill",
      componentId: skill.name,
      support: "native",
    });
  }

  for (const server of Object.values(pack.mcpServers)) {
    if (server.enabled === false) continue;
    findings.push({
      target: "kimi",
      componentType: "mcp",
      componentId: server.name,
      support: "native",
    });
  }

  for (const instruction of pack.instructions) {
    if (!targetsKimi(instruction.targets)) continue;
    findings.push({
      target: "kimi",
      componentType: "instruction",
      componentId: instruction.id,
      support: "native",
    });
  }

  if (pack.plugin?.enabled) {
    findings.push({
      target: "kimi",
      componentType: "plugin",
      componentId: pack.metadata.name,
      support: "native",
    });
  }

  for (const hook of pack.hooks) {
    if (!targetsKimi(hook.targets)) continue;
    if (hook.event === "notification") {
      findings.push({
        target: "kimi",
        componentType: "hook",
        componentId: hook.id,
        support: "unsupported",
        message: "kimi hooks.json does not support the notification event",
        remediation: "use sessionEnd or a skill instead",
      });
    } else {
      findings.push({
        target: "kimi",
        componentType: "hook",
        componentId: hook.id,
        support: "transpiled",
        message: "rendered to kimi hooks.json",
      });
    }
  }

  return { findings };
}
