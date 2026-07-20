import path from "node:path";

import type {
  AdapterContext,
  CanonicalInstruction,
  CanonicalMcpServer,
  CanonicalPack,
  CanonicalSkill,
  DetectionContext,
  InstallContext,
  TargetDetection,
} from "@agentpack/schema";

export const PROJECT_ROOT = path.join(path.sep, "repo");
export const HOME_DIR = path.join(path.sep, "home", "user");
export const PACK_ROOT = path.join(path.sep, "packs", "test-pack");

export function makeDetection(overrides: Partial<TargetDetection> = {}): TargetDetection {
  return {
    installed: true,
    executablePath: "/usr/local/bin/codex",
    version: "1.2.3",
    userConfigRoot: path.join(HOME_DIR, ".codex"),
    projectConfigRoot: path.join(PROJECT_ROOT, ".codex"),
    warnings: [],
    ...overrides,
  };
}

export function makeDetectionContext(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    env: {},
    homeDir: HOME_DIR,
    projectRoot: PROJECT_ROOT,
    platform: "linux",
    ...overrides,
  };
}

export function makeContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    scope: "project",
    projectRoot: PROJECT_ROOT,
    homeDir: HOME_DIR,
    env: {},
    detection: makeDetection(),
    options: {},
    ...overrides,
  };
}

export function makeInstallContext(overrides: Partial<InstallContext> = {}): InstallContext {
  return {
    ...makeContext(),
    installMode: "auto",
    symlinksReliable: true,
    ...overrides,
  };
}

export function makeSkill(name: string): CanonicalSkill {
  return {
    name,
    description: `${name} skill`,
    rootDir: path.join(PACK_ROOT, "skills", name),
    files: ["SKILL.md"],
    frontmatter: { name, description: `${name} skill` },
  };
}

export function makeInstruction(
  overrides: Partial<CanonicalInstruction> = {},
): CanonicalInstruction {
  return {
    id: "rules",
    sourcePath: path.join(PACK_ROOT, "instructions", "rules.md"),
    content: "Follow the rules.",
    scope: "project",
    priority: 100,
    mergeStrategy: "managed-section",
    ...overrides,
  };
}

export function makeStdioServer(
  name: string,
  overrides: Partial<CanonicalMcpServer> = {},
): CanonicalMcpServer {
  return {
    name,
    transport: "stdio",
    command: "run-server",
    enabled: true,
    ...overrides,
  };
}

export function makePack(overrides: Partial<CanonicalPack> = {}): CanonicalPack {
  return {
    metadata: { name: "test-pack", version: "1.0.0" },
    rootDir: PACK_ROOT,
    skills: [],
    instructions: [],
    mcpServers: {},
    hooks: [],
    targetExtensions: {},
    targetEnabled: {},
    ...overrides,
  };
}
