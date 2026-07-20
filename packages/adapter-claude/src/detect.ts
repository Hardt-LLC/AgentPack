import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DetectionContext, TargetDetection } from "@agentpack/schema";

const execFileAsync = promisify(execFile);

const VERSION_PATTERN = /(\d+\.\d+(?:\.\d+)?)/;

/**
 * Best-effort Claude Code detection. Never throws: a missing executable means
 * "not installed", and a failing version probe degrades to a warning.
 */
export async function detect(context: DetectionContext): Promise<TargetDetection> {
  const userConfigRoot = path.join(context.homeDir, ".claude");
  const projectConfigRoot = path.join(context.projectRoot, ".claude");
  const warnings: string[] = [];

  const findExecutable = context.findExecutable ?? (async () => undefined);
  const executablePath = await findExecutable("claude");
  if (!executablePath) {
    return { installed: false, userConfigRoot, projectConfigRoot, warnings };
  }

  let version: string | undefined;
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
      timeout: 5000,
    });
    const text = (stdout || stderr).trim();
    version = VERSION_PATTERN.exec(text)?.[1] ?? (text || undefined);
  } catch (error) {
    warnings.push(`failed to determine the Claude Code version: ${(error as Error).message}`);
  }

  return { installed: true, executablePath, version, userConfigRoot, projectConfigRoot, warnings };
}
