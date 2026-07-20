import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AdapterContext,
  CanonicalPack,
  InstallContext,
  TargetDetection,
} from "@agentpack/schema";

export async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-kimi-"));
}

export function makeDetection(overrides: Partial<TargetDetection> = {}): TargetDetection {
  return {
    installed: true,
    userConfigRoot: "",
    projectConfigRoot: "",
    warnings: [],
    ...overrides,
  };
}

export function makeContext(tmp: string, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    scope: "project",
    projectRoot: path.join(tmp, "project"),
    homeDir: path.join(tmp, "home"),
    env: {},
    detection: makeDetection(),
    options: {},
    ...overrides,
  };
}

export function makeInstallContext(
  tmp: string,
  overrides: Partial<InstallContext> = {},
): InstallContext {
  return {
    ...makeContext(tmp, overrides),
    installMode: "auto",
    symlinksReliable: true,
    ...overrides,
  };
}

export function makePack(rootDir: string, overrides: Partial<CanonicalPack> = {}): CanonicalPack {
  return {
    metadata: { name: "test-pack", version: "1.0.0" },
    rootDir,
    skills: [],
    instructions: [],
    mcpServers: {},
    hooks: [],
    targetExtensions: {},
    targetEnabled: {},
    ...overrides,
  };
}
