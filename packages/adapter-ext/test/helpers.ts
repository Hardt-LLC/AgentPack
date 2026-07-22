import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AdapterContext,
  CanonicalHook,
  CanonicalInstruction,
  CanonicalMcpServer,
  CanonicalPack,
  CanonicalSkill,
  ImportContext,
  InstallContext,
  TargetDetection,
} from "@agentpack/schema";

export async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-ext-"));
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

export function makeImportContext(
  tmp: string,
  overrides: Partial<ImportContext> = {},
): ImportContext {
  return {
    scope: "user",
    projectRoot: path.join(tmp, "project"),
    homeDir: path.join(tmp, "home"),
    env: {},
    options: {},
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

/**
 * Write a fake executable shell script. With a version it prints
 * "<name> <version>" on `--version`; without one it exits 1.
 */
export async function makeExecutable(dir: string, name: string, version?: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const body = version ? `#!/bin/sh\necho "${name} ${version}"\n` : `#!/bin/sh\nexit 1\n`;
  await fs.writeFile(file, body, { mode: 0o755 });
  return file;
}

export const skill: CanonicalSkill = {
  name: "review",
  description: "Review code",
  rootDir: "/packs/test/skills/review",
  files: ["SKILL.md"],
  frontmatter: { name: "review" },
};

export const stdioServer: CanonicalMcpServer = {
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" }, LOG_LEVEL: { value: "debug" } },
  enabled: true,
};

export const httpServer: CanonicalMcpServer = {
  name: "docs",
  transport: "http",
  url: "https://example.com/mcp",
  headers: { Authorization: { fromEnv: "API_TOKEN" } },
  enabled: true,
};

export const sseServer: CanonicalMcpServer = {
  name: "events",
  transport: "sse",
  url: "https://example.com/sse",
  enabled: true,
};

export const projectInstruction: CanonicalInstruction = {
  id: "coding-style",
  sourcePath: "/packs/test/instructions/coding-style.md",
  content: "Use strict TypeScript.",
  scope: "project",
  priority: 100,
  mergeStrategy: "managed-section",
};

export const globalInstruction: CanonicalInstruction = {
  id: "global-style",
  sourcePath: "/packs/test/instructions/global-style.md",
  content: "Be concise.",
  scope: "global",
  priority: 100,
  mergeStrategy: "managed-section",
};

export const directoryInstruction: CanonicalInstruction = {
  id: "dir-style",
  sourcePath: "/packs/test/instructions/dir-style.md",
  content: "Directory rules.",
  scope: "directory",
  directory: "src",
  priority: 100,
  mergeStrategy: "managed-section",
};

export const hook: CanonicalHook = {
  id: "lint",
  event: "preToolUse",
  matcher: "shell",
  command: ["pnpm", "lint"],
};
