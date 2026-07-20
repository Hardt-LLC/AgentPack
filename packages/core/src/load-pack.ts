import { promises as fs } from "node:fs";
import path from "node:path";
import {
  findHardcodedSecrets,
  type CanonicalInstruction,
  type CanonicalMcpServer,
  type CanonicalPack,
  type Diagnostic,
  type TargetId,
  TARGET_IDS,
} from "@agentpack/schema";
import { resolveInside } from "@agentpack/filesystem";
import { parsePackManifest } from "./load-workspace.js";
import { loadSkill } from "./skill.js";

export const PACK_FILE = "pack.yaml";

export interface LoadPackResult {
  rootDir: string;
  manifest: import("@agentpack/schema").PackManifest | undefined;
  pack: CanonicalPack | undefined;
  diagnostics: Diagnostic[];
  /** Raw pack.yaml text (for secret scanning / hashing). */
  rawManifest: string;
}

/** Load and validate a pack directory (pack.yaml + skills + instructions). */
export async function loadPack(rootDir: string): Promise<LoadPackResult> {
  const diagnostics: Diagnostic[] = [];
  rootDir = path.resolve(rootDir);
  const manifestPath = path.join(rootDir, PACK_FILE);

  let rawManifest: string;
  try {
    rawManifest = await fs.readFile(manifestPath, "utf8");
  } catch {
    return {
      rootDir,
      manifest: undefined,
      pack: undefined,
      rawManifest: "",
      diagnostics: [{ severity: "error", message: "pack.yaml not found", source: rootDir }],
    };
  }

  // Warn on hardcoded secrets in the canonical manifest (values never printed).
  for (const finding of findHardcodedSecrets(rawManifest)) {
    diagnostics.push({
      severity: "warning",
      message: `possible hardcoded secret (${finding.pattern}) at line ${finding.line} — use { fromEnv: VAR } instead`,
      source: manifestPath,
    });
  }

  const { manifest, diagnostics: manifestDiags } = parsePackManifest(rawManifest, manifestPath);
  diagnostics.push(...manifestDiags);
  if (!manifest) return { rootDir, manifest, pack: undefined, diagnostics, rawManifest };

  const packName = manifest.metadata.name;

  // Skills
  const skills: CanonicalPack["skills"] = [];
  const seenSkills = new Set<string>();
  for (const entry of manifest.spec.skills) {
    let skillDir: string;
    try {
      skillDir = resolveInside(rootDir, entry.path);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        message: (error as Error).message,
        source: manifestPath,
      });
      continue;
    }
    const { skill, diagnostics: skillDiags } = await loadSkill(skillDir);
    diagnostics.push(...skillDiags);
    if (skill) {
      if (seenSkills.has(skill.name)) {
        diagnostics.push({
          severity: "error",
          message: `duplicate skill "${skill.name}" in pack ${packName}`,
          source: manifestPath,
        });
      }
      seenSkills.add(skill.name);
      skills.push(skill);
    }
  }

  // Instructions
  const instructions: CanonicalInstruction[] = [];
  const seenInstructionIds = new Set<string>();
  for (const spec of manifest.spec.instructions) {
    if (seenInstructionIds.has(spec.id)) {
      diagnostics.push({
        severity: "error",
        message: `duplicate instruction id "${spec.id}" in pack ${packName}`,
        source: manifestPath,
      });
    }
    seenInstructionIds.add(spec.id);
    let sourcePath: string;
    try {
      sourcePath = resolveInside(rootDir, spec.path);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        message: (error as Error).message,
        source: manifestPath,
      });
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(sourcePath, "utf8");
    } catch {
      diagnostics.push({
        severity: "error",
        message: `instruction file not found: ${spec.path}`,
        source: manifestPath,
      });
      continue;
    }
    instructions.push({
      id: spec.id,
      sourcePath,
      content,
      scope: spec.scope,
      directory: spec.directory,
      priority: spec.priority,
      mergeStrategy: spec.mergeStrategy,
      targets: spec.targets,
    });
  }

  // MCP servers (attach names)
  const mcpServers: Record<string, CanonicalMcpServer> = {};
  for (const [name, server] of Object.entries(manifest.spec.mcpServers)) {
    mcpServers[name] = { ...server, name };
  }

  // Target enablement + extensions
  const targetEnabled: Partial<Record<TargetId, boolean>> = {};
  const targetExtensions: Partial<Record<TargetId, Record<string, unknown>>> = {};
  for (const target of TARGET_IDS) {
    targetEnabled[target] = manifest.spec.targets?.[target]?.enabled ?? true;
    const ext = manifest.spec.extensions?.[target];
    if (ext) targetExtensions[target] = ext;
  }

  const pack: CanonicalPack = {
    metadata: manifest.metadata,
    rootDir,
    skills,
    instructions,
    mcpServers,
    hooks: manifest.spec.hooks,
    plugin: manifest.spec.plugin,
    targetExtensions,
    targetEnabled,
  };

  return { rootDir, manifest, pack, diagnostics, rawManifest };
}
