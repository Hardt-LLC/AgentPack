import type { TargetAdapter } from "@agentpack/schema";

import { antigravityAdapter } from "./antigravity.js";
import { clineAdapter } from "./cline.js";
import { copilotCliAdapter } from "./copilot-cli.js";
import { copilotVscodeAdapter } from "./copilot-vscode.js";
import { cursorAdapter } from "./cursor.js";
import { droidAdapter } from "./droid.js";
import { geminiAdapter } from "./gemini.js";
import { hermesAdapter } from "./hermes.js";
import { kiloAdapter } from "./kilo.js";
import { openclawAdapter } from "./openclaw.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { rooAdapter } from "./roo.js";
import { vibeAdapter } from "./vibe.js";
import { windsurfAdapter } from "./windsurf.js";

export { defineSimpleAdapter } from "./factory.js";
export type { EnvRefFormat, ServerShapeOptions, SimpleAdapterSpec } from "./factory.js";
export { cursorAdapter } from "./cursor.js";
export { windsurfAdapter } from "./windsurf.js";
export { clineAdapter } from "./cline.js";
export { rooAdapter } from "./roo.js";
export { kiloAdapter } from "./kilo.js";
export { copilotVscodeAdapter } from "./copilot-vscode.js";
export { copilotCliAdapter } from "./copilot-cli.js";
export { geminiAdapter } from "./gemini.js";
export { antigravityAdapter } from "./antigravity.js";
export { opencodeAdapter } from "./opencode.js";
export { openclawAdapter } from "./openclaw.js";
export { piAdapter } from "./pi.js";
export { hermesAdapter } from "./hermes.js";
export { vibeAdapter } from "./vibe.js";
export { droidAdapter } from "./droid.js";

/** All declarative "simple" adapters built on defineSimpleAdapter. */
export const extAdapters: TargetAdapter[] = [
  cursorAdapter,
  windsurfAdapter,
  clineAdapter,
  rooAdapter,
  kiloAdapter,
  copilotVscodeAdapter,
  copilotCliAdapter,
  geminiAdapter,
  antigravityAdapter,
  opencodeAdapter,
  openclawAdapter,
  piAdapter,
  hermesAdapter,
  vibeAdapter,
  droidAdapter,
];
