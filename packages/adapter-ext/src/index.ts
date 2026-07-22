import type { TargetAdapter } from "@agentpack/schema";

import { clineAdapter } from "./cline.js";
import { cursorAdapter } from "./cursor.js";
import { kiloAdapter } from "./kilo.js";
import { rooAdapter } from "./roo.js";
import { windsurfAdapter } from "./windsurf.js";

export { defineSimpleAdapter } from "./factory.js";
export type { EnvRefFormat, ServerShapeOptions, SimpleAdapterSpec } from "./factory.js";
export { cursorAdapter } from "./cursor.js";
export { windsurfAdapter } from "./windsurf.js";
export { clineAdapter } from "./cline.js";
export { rooAdapter } from "./roo.js";
export { kiloAdapter } from "./kilo.js";

/** All declarative "simple" adapters built on defineSimpleAdapter. */
export const extAdapters: TargetAdapter[] = [
  cursorAdapter,
  windsurfAdapter,
  clineAdapter,
  rooAdapter,
  kiloAdapter,
];
