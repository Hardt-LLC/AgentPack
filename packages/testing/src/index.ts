import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a temporary directory; caller cleans up with the returned fn. */
export async function makeTempDir(prefix = "agentpack-test-"): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  // realpath resolves macOS /var symlinks and Windows 8.3 short names so
  // path comparisons in tests are stable.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Write a tree of files: { "a/b.txt": "content" } under root. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(root, ...rel.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
  }
}

/** Read a tree of files back (relative posix path → content). */
export async function readTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        out[path.relative(root, abs).split(path.sep).join("/")] = await fs.readFile(abs, "utf8");
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Create a fake executable on a temporary PATH directory. Returns the bin
 * dir to prepend to PATH. The executable prints `version` for --version.
 */
export async function makeFakeExecutable(
  binDir: string,
  name: string,
  version = "1.0.0",
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true });
  const script = path.join(binDir, name);
  await fs.writeFile(script, `#!/bin/sh\necho "${name} ${version}"\n`);
  await fs.chmod(script, 0o755);
  return binDir;
}

/** A minimal valid Agent Skill directory tree. */
export function skillTree(name: string, description = `${name} skill`): Record<string, string> {
  return {
    [`${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  };
}

/** Minimal environment record for deterministic tests. */
export function fakeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: "/nonexistent", ...overrides };
}
