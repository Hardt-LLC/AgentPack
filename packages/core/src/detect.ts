import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  TARGET_IDS,
  type AdapterContext,
  type DetectionContext,
  type Scope,
  type TargetDetection,
  type TargetId,
} from "@agentpack/schema";
import type { AdapterRegistry } from "./registry.js";

const execFileAsync = promisify(execFile);

export type DetectedTargets = Partial<Record<TargetId, TargetDetection>>;

/** Default PATH executable lookup (injectable for tests). */
export async function defaultFindExecutable(name: string): Promise<string | undefined> {
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

export interface DetectOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  findExecutable?: (name: string) => Promise<string | undefined>;
  platform?: NodeJS.Platform;
}

/** Run detection for every registered target. Never fails hard. */
export async function detectTargets(
  registry: AdapterRegistry,
  projectRoot: string,
  opts: DetectOptions = {},
): Promise<DetectedTargets> {
  const context: DetectionContext = {
    env: opts.env ?? process.env,
    homeDir: opts.homeDir ?? os.homedir(),
    projectRoot,
    platform: opts.platform ?? process.platform,
    findExecutable: opts.findExecutable ?? defaultFindExecutable,
  };
  const out: DetectedTargets = {};
  await Promise.all(
    registry.all().map(async (adapter) => {
      try {
        out[adapter.id] = await adapter.detect(context);
      } catch (error) {
        out[adapter.id] = {
          installed: false,
          userConfigRoot: "",
          projectConfigRoot: "",
          warnings: [`detection failed: ${(error as Error).message}`],
        };
      }
    }),
  );
  return out;
}

export function buildAdapterContext(
  adapter: { id: TargetId },
  detection: TargetDetection | undefined,
  scope: Scope,
  projectRoot: string,
  env: Record<string, string | undefined>,
  options: Record<string, unknown> = {},
): AdapterContext {
  const homeDir = options.homeDir as string | undefined;
  return {
    scope,
    projectRoot,
    homeDir: homeDir ?? os.homedir(),
    env,
    detection: detection ?? {
      installed: false,
      userConfigRoot: "",
      projectConfigRoot: "",
      warnings: [`${adapter.id} was not detected`],
    },
    options,
  };
}

/** Try to read a tool version; failure must be a warning, never fatal. */
export async function probeVersion(
  executablePath: string,
  args: string[] = ["--version"],
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, { timeout: 5000 });
    const text = (stdout || stderr).trim();
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(text);
    return match?.[1] ?? (text || undefined);
  } catch {
    return undefined;
  }
}

export { TARGET_IDS };
