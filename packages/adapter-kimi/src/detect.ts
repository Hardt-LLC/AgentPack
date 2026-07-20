import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { pathExists } from "@agentpack/filesystem";
import type { DetectionContext, TargetDetection } from "@agentpack/schema";

import { projectConfigRoot, resolveKimiHome } from "./paths.js";

const execFileAsync = promisify(execFile);

/** Probe `kimi --version`; failure is reported by the caller as a warning. */
async function probeVersion(executablePath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
      timeout: 5000,
    });
    const text = (stdout || stderr).trim();
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(text);
    return match?.[1] ?? (text || undefined);
  } catch {
    return undefined;
  }
}

/** Best-effort detection of Kimi Code. Never throws when the agent is absent. */
export async function detectKimi(context: DetectionContext): Promise<TargetDetection> {
  const kimiHome = resolveKimiHome(context.env, context.homeDir);
  const projectConfig = projectConfigRoot(context.projectRoot);
  const warnings: string[] = [];

  const executablePath = context.findExecutable ? await context.findExecutable("kimi") : undefined;
  let version: string | undefined;
  if (executablePath) {
    version = await probeVersion(executablePath);
    if (!version) {
      warnings.push(`kimi found at ${executablePath} but \`kimi --version\` failed`);
    }
  }

  const [hasProjectConfig, hasUserConfig] = await Promise.all([
    pathExists(projectConfig),
    pathExists(kimiHome),
  ]);

  return {
    installed: executablePath !== undefined || hasProjectConfig || hasUserConfig,
    executablePath,
    version,
    userConfigRoot: kimiHome,
    projectConfigRoot: projectConfig,
    warnings,
  };
}
