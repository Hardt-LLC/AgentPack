import { createRegistry, type AdapterRegistry } from "@agentpack/core";
import { createClaudeAdapter } from "@agentpack/adapter-claude";
import { createCodexAdapter } from "@agentpack/adapter-codex";
import { createKimiAdapter } from "@agentpack/adapter-kimi";
import { extAdapters } from "@agentpack/adapter-ext";

/** The default registry with every shipped target adapter. */
export function defaultRegistry(): AdapterRegistry {
  return createRegistry([
    createCodexAdapter(),
    createClaudeAdapter(),
    createKimiAdapter(),
    ...extAdapters,
  ]);
}
