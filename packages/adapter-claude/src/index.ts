import type { TargetAdapter } from "@agentpack/schema";

import { analyze } from "./analyze.js";
import { detect } from "./detect.js";
import { generate } from "./generate.js";
import { importConfig } from "./import.js";
import { planInstall } from "./plan-install.js";

/** Create a fresh Claude Code target adapter. */
export function createClaudeAdapter(): TargetAdapter {
  return {
    id: "claude",
    detect,
    analyze,
    generate,
    planInstall,
    import: importConfig,
  };
}

/** Shared Claude Code adapter instance. */
export const claudeAdapter: TargetAdapter = createClaudeAdapter();
