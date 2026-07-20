import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { NAME_PATTERN, type CanonicalSkill, type Diagnostic } from "@agentpack/schema";
import { toPosixPath } from "@agentpack/filesystem";

export interface SkillLoadResult {
  skill: CanonicalSkill | undefined;
  diagnostics: Diagnostic[];
}

/** Extract YAML frontmatter from a Markdown document. */
export function parseFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown> | undefined;
  body: string;
  error?: string;
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: undefined, body: normalized, error: "missing YAML frontmatter" };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: undefined, body: normalized, error: "unterminated YAML frontmatter" };
  }
  const raw = normalized.slice(4, end);
  try {
    const parsed: unknown = parseYaml(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { frontmatter: undefined, body: normalized, error: "frontmatter must be a mapping" };
    }
    return { frontmatter: parsed as Record<string, unknown>, body: normalized.slice(end + 4) };
  } catch (error) {
    return {
      frontmatter: undefined,
      body: normalized,
      error: `invalid frontmatter YAML: ${(error as Error).message}`,
    };
  }
}

/** Collect all files below a directory as sorted POSIX relative paths. */
export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosixPath(path.relative(rootDir, abs));
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(rel);
      }
    }
  }
  await walk(rootDir);
  return out.sort();
}

/** Markdown local links: [text](target) — ignore URLs, anchors and mailto. */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

/**
 * Load and validate an Agent Skill directory.
 *
 * Rules (spec §3.1): SKILL.md exists; valid frontmatter with name +
 * description; name matches the directory name; name charset; referenced
 * local files stay inside the skill root; no path traversal.
 */
export async function loadSkill(rootDir: string): Promise<SkillLoadResult> {
  const diagnostics: Diagnostic[] = [];
  const source = rootDir;
  const dirName = path.basename(rootDir);

  const skillMdPath = path.join(rootDir, "SKILL.md");
  let markdown: string;
  try {
    markdown = await fs.readFile(skillMdPath, "utf8");
  } catch {
    return {
      skill: undefined,
      diagnostics: [{ severity: "error", message: "SKILL.md not found", source }],
    };
  }

  const { frontmatter, error } = parseFrontmatter(markdown);
  if (error || !frontmatter) {
    diagnostics.push({
      severity: "error",
      message: error ?? "missing frontmatter",
      source: skillMdPath,
    });
    return { skill: undefined, diagnostics };
  }

  const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : undefined;

  if (!name)
    diagnostics.push({
      severity: "error",
      message: "frontmatter missing `name`",
      source: skillMdPath,
    });
  if (!description) {
    diagnostics.push({
      severity: "error",
      message: "frontmatter missing `description`",
      source: skillMdPath,
    });
  }
  if (name && !NAME_PATTERN.test(name)) {
    diagnostics.push({
      severity: "error",
      message: `skill name "${name}" must contain only lowercase letters, numbers and hyphens`,
      source: skillMdPath,
    });
  }
  if (name && name !== dirName) {
    diagnostics.push({
      severity: "error",
      message: `skill name "${name}" does not match directory name "${dirName}"`,
      source: skillMdPath,
    });
  }

  const files = await listFilesRecursive(rootDir);

  // Symlinks must not escape the skill root.
  for (const rel of files) {
    const abs = path.join(rootDir, rel);
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(abs).catch(() => undefined);
      const rootReal = await fs.realpath(rootDir);
      if (!real || !(real === rootReal || real.startsWith(rootReal + path.sep))) {
        diagnostics.push({
          severity: "error",
          message: `symlink escapes skill root: ${rel}`,
          source: abs,
        });
      }
    }
  }

  // Referenced local files must exist and stay inside the skill root.
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const target = match[1];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const cleaned = target.split("#")[0] ?? "";
    if (!cleaned) continue;
    const resolved = path.resolve(rootDir, cleaned);
    const rootResolved = path.resolve(rootDir);
    if (!(resolved === rootResolved || resolved.startsWith(rootResolved + path.sep))) {
      diagnostics.push({
        severity: "error",
        message: `referenced file escapes skill root: ${target}`,
        source: skillMdPath,
      });
      continue;
    }
    const exists = await fs.stat(resolved).then(
      () => true,
      () => false,
    );
    if (!exists) {
      diagnostics.push({
        severity: "warning",
        message: `referenced file not found: ${target}`,
        source: skillMdPath,
      });
    }
  }

  if (diagnostics.some((d) => d.severity === "error") || !name || !description) {
    return { skill: undefined, diagnostics };
  }
  return {
    skill: { name, description, rootDir, files, frontmatter },
    diagnostics,
  };
}
