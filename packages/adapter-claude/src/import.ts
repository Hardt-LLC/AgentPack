import fs from "node:fs/promises";
import path from "node:path";

import {
  listManagedSections,
  readFileIfExists,
  sectionContent,
  sha256,
  toPosixPath,
} from "@agentpack/filesystem";
import { parse as parseYaml } from "yaml";
import type {
  CanonicalHook,
  CanonicalMcpServer,
  ImportContext,
  ImportedConfiguration,
  ImportedInstruction,
  ImportedSkill,
} from "@agentpack/schema";

import { CANONICAL_HOOK_EVENTS } from "./hooks.js";
import { importMcpServer } from "./mcp.js";
import { nativeImportPaths } from "./paths.js";

const MAX_TEXT_FILE_BYTES = 1024 * 1024;

function parseJsonFile(
  content: string | undefined,
  filePath: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (content === undefined || content.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warnings.push(`${filePath}: expected a top-level JSON object, skipping`);
  } catch (error) {
    warnings.push(`${filePath}: invalid JSON (${(error as Error).message}), skipping`);
  }
  return undefined;
}

/* ------------------------------- MCP -------------------------------- */

function importMcpServers(
  mcpFile: Record<string, unknown> | undefined,
  mcpFilePath: string,
  warnings: string[],
): Record<string, Omit<CanonicalMcpServer, "name">> {
  const servers: Record<string, Omit<CanonicalMcpServer, "name">> = {};
  const rawServers = mcpFile?.mcpServers;
  if (rawServers === undefined) return servers;
  if (typeof rawServers !== "object" || rawServers === null || Array.isArray(rawServers)) {
    warnings.push(`${mcpFilePath}: "mcpServers" is not an object, skipping`);
    return servers;
  }
  for (const [name, raw] of Object.entries(rawServers)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warnings.push(`${mcpFilePath}: server "${name}" is not an object, skipping`);
      continue;
    }
    servers[name] = importMcpServer(raw as Record<string, unknown>);
  }
  return servers;
}

/* --------------------------- Instructions ---------------------------- */

function importInstructions(
  content: string | undefined,
  scope: "project" | "user",
): ImportedInstruction[] {
  if (content === undefined) return [];
  const instructionScope = scope === "project" ? "project" : "global";
  const sectionIds = listManagedSections(content);
  if (sectionIds.length > 0) {
    const instructions: ImportedInstruction[] = [];
    for (const id of sectionIds) {
      const body = sectionContent(content, id);
      if (body !== undefined) instructions.push({ id, content: body, scope: instructionScope });
    }
    return instructions;
  }
  const trimmed = content.trim();
  if (trimmed === "") return [];
  return [{ id: "imported-claude", content: trimmed, scope: instructionScope }];
}

/* ------------------------------ Skills ------------------------------- */

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  try {
    const parsed: unknown = parseYaml(match[1]!);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed frontmatter — treat as absent.
  }
  return {};
}

async function readSkillFiles(rootDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(full);
        if (stat.size > MAX_TEXT_FILE_BYTES) continue;
        const buffer = await fs.readFile(full);
        if (buffer.includes(0)) continue; // binary file
        files[toPosixPath(path.relative(rootDir, full))] = buffer.toString("utf8");
      }
    }
  }
  await walk(rootDir);
  return files;
}

function skillContentHash(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((rel) => `${rel}:${sha256(files[rel]!)}`);
  return sha256(lines.join("\n"));
}

async function importSkills(skillsDir: string): Promise<ImportedSkill[]> {
  const skills: ImportedSkill[] = [];
  let dirents;
  try {
    dirents = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return skills; // No skills directory.
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const rootDir = path.join(skillsDir, dirent.name);
    const skillMd = await readFileIfExists(path.join(rootDir, "SKILL.md"));
    if (skillMd === undefined) continue;
    const frontmatter = parseFrontmatter(skillMd);
    const files = await readSkillFiles(rootDir);
    skills.push({
      name: typeof frontmatter.name === "string" ? frontmatter.name : dirent.name,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
      files,
      contentHash: skillContentHash(files),
    });
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return skills;
}

/* ------------------------------- Hooks ------------------------------- */

interface ImportedHooks {
  canonical: CanonicalHook[];
  raw: Record<string, unknown> | undefined;
}

function importHooks(settings: Record<string, unknown> | undefined): ImportedHooks {
  const canonical: CanonicalHook[] = [];
  const rawHooks = settings?.hooks;
  if (typeof rawHooks !== "object" || rawHooks === null || Array.isArray(rawHooks)) {
    return { canonical, raw: undefined };
  }
  for (const [eventName, entries] of Object.entries(rawHooks)) {
    const event = CANONICAL_HOOK_EVENTS[eventName];
    if (!event || !Array.isArray(entries)) continue;
    let index = 0;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const commandHooks = Array.isArray(record.hooks) ? record.hooks : [];
      for (const commandHook of commandHooks) {
        if (typeof commandHook !== "object" || commandHook === null) continue;
        const command = (commandHook as Record<string, unknown>).command;
        if (typeof command !== "string" || command === "") continue;
        const hook: CanonicalHook = {
          id: `imported-${eventName.toLowerCase()}-${index}`,
          event,
          // Command splitting would be lossy; run the raw string via sh.
          command: ["/bin/sh", "-c", command],
        };
        if (typeof record.matcher === "string" && record.matcher !== "") {
          hook.matcher = record.matcher;
        }
        canonical.push(hook);
        index += 1;
      }
    }
  }
  return { canonical, raw: rawHooks as Record<string, unknown> };
}

/* ------------------------------ Import ------------------------------- */

const KNOWN_SETTINGS_KEYS = new Set(["hooks"]);

/**
 * Read Claude Code's native configuration into canonical form. Read-only: the
 * native files are never modified. Hooks have no slot in ImportedConfiguration,
 * so raw entries land in extensions.hooks and the canonical hooks derived from
 * them in extensions.importedHooks.
 */
export async function importConfig(context: ImportContext): Promise<ImportedConfiguration> {
  const warnings: string[] = [];
  const paths = nativeImportPaths(context.scope, context.projectRoot, context.homeDir);

  const mcpFile = parseJsonFile(await readFileIfExists(paths.mcpFile), paths.mcpFile, warnings);
  const mcpServers = importMcpServers(mcpFile, paths.mcpFile, warnings);

  const instructions = importInstructions(await readFileIfExists(paths.claudeMd), context.scope);

  const skills = await importSkills(paths.skillsDir);

  const settings = parseJsonFile(
    await readFileIfExists(paths.settingsFile),
    paths.settingsFile,
    warnings,
  );
  const hooks = importHooks(settings);

  const extensions: Record<string, unknown> = {};
  if (hooks.raw !== undefined) extensions.hooks = hooks.raw;
  if (hooks.canonical.length > 0) extensions.importedHooks = hooks.canonical;
  if (settings) {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (!KNOWN_SETTINGS_KEYS.has(key)) extra[key] = value;
    }
    if (Object.keys(extra).length > 0) extensions.settings = extra;
  }

  return { skills, mcpServers, instructions, extensions, warnings };
}
