import type { CanonicalPack } from "@agentpack/schema";

/** Claude subagent extension entry from spec.extensions.claude.agents. */
export interface ClaudeAgentExtension {
  name: string;
  description: string;
  content: string;
}

function isAgentExtension(value: unknown): value is ClaudeAgentExtension {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.description === "string" &&
    typeof record.content === "string"
  );
}

/** Read the documented targetExtensions.claude.agents extension point. */
export function readClaudeAgents(pack: CanonicalPack): ClaudeAgentExtension[] {
  const raw = pack.targetExtensions.claude?.agents;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAgentExtension);
}

/** Render an agent extension as a Claude subagent markdown file. */
export function claudeAgentFileContent(agent: ClaudeAgentExtension): string {
  const body = agent.content.replace(/\s+$/u, "");
  return `---\nname: ${agent.name}\ndescription: ${agent.description}\n---\n\n${body}\n`;
}
