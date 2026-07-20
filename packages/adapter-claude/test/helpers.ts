import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdapterContext, CanonicalPack, InstallContext, Scope } from "@agentpack/schema";

export async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-adapter-claude-"));
}

export function makePack(overrides: Partial<CanonicalPack> = {}): CanonicalPack {
  return {
    metadata: { name: "test-pack", version: "1.0.0", description: "A test pack" },
    rootDir: "/packs/test-pack",
    skills: [],
    instructions: [],
    mcpServers: {},
    hooks: [],
    targetExtensions: {},
    targetEnabled: {},
    ...overrides,
  };
}

export function makeAdapterContext(
  tmp: string,
  scope: Scope,
  options: Record<string, unknown> = {},
): AdapterContext {
  const projectRoot = path.join(tmp, "project");
  const homeDir = path.join(tmp, "home");
  return {
    scope,
    projectRoot,
    homeDir,
    env: {},
    detection: {
      installed: true,
      userConfigRoot: path.join(homeDir, ".claude"),
      projectConfigRoot: path.join(projectRoot, ".claude"),
      warnings: [],
    },
    options,
  };
}

export function makeInstallContext(
  tmp: string,
  scope: Scope,
  overrides: Partial<InstallContext> = {},
): InstallContext {
  return {
    ...makeAdapterContext(tmp, scope),
    installMode: "auto",
    symlinksReliable: true,
    ...overrides,
  };
}

/** Create a real skill directory with a SKILL.md and return its root. */
export async function makeSkillDir(rootDir: string, name: string): Promise<string> {
  const skillDir = path.join(rootDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n`,
  );
  return skillDir;
}
