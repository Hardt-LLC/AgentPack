import type { TargetAdapter } from "@agentpack/schema";

import { analyzeKimi } from "./analyze.js";
import { detectKimi } from "./detect.js";
import { generateKimi } from "./generate.js";
import { importKimi } from "./import.js";
import { planKimiInstall } from "./plan.js";

/** Create a fresh Kimi Code target adapter instance. */
export function createKimiAdapter(): TargetAdapter {
  return {
    id: "kimi",
    detect: detectKimi,
    analyze: analyzeKimi,
    generate: generateKimi,
    planInstall: planKimiInstall,
    import: importKimi,
  };
}

/** Shared Kimi Code target adapter instance. */
export const kimiAdapter: TargetAdapter = createKimiAdapter();

export { buildHookEntry, groupHooksByEvent } from "./hooks.js";
export { buildMcpServerValue } from "./mcp.js";
export { resolveKimiHome, resolvePathStrategy, type PathStrategy } from "./paths.js";
