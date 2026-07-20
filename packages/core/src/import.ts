import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  API_VERSION,
  NAME_PATTERN,
  type Diagnostic,
  type ImportedConfiguration,
  type Scope,
  type TargetId,
} from "@agentpack/schema";
import { ensureDir, hashDirectory, sha256, writeFileAtomic } from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface ImportResult {
  packName: string;
  packDir: string;
  skillsWritten: string[];
  skillsSkippedDuplicates: string[];
  mcpServerCount: number;
  instructionCount: number;
  warnings: string[];
  diagnostics: Diagnostic[];
  dryRun: boolean;
}

export interface ImportOptions {
  scope?: Scope;
  packName?: string;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  options?: Record<string, unknown>;
}

/**
 * Import native configuration from a target into a new canonical pack.
 * The source configuration is never modified.
 */
export async function importFromTarget(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  target: TargetId,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const diagnostics: Diagnostic[] = [];
  const adapter = registry.get(target);
  if (!adapter.import) {
    diagnostics.push({ severity: "error", message: `target "${target}" does not support import` });
    return {
      packName: "",
      packDir: "",
      skillsWritten: [],
      skillsSkippedDuplicates: [],
      mcpServerCount: 0,
      instructionCount: 0,
      warnings: [],
      diagnostics,
      dryRun: opts.dryRun === true,
    };
  }

  const imported: ImportedConfiguration = await adapter.import({
    scope: opts.scope ?? "project",
    projectRoot: workspace.rootDir,
    homeDir: opts.homeDir ?? process.env.HOME ?? "",
    env: opts.env ?? process.env,
    options: opts.options ?? {},
  });

  const packName = opts.packName ?? `imported-${target}`;
  if (!NAME_PATTERN.test(packName)) {
    diagnostics.push({ severity: "error", message: `invalid pack name: ${packName}` });
  }
  const packDir = path.join(workspace.rootDir, "packs", packName);

  // Deduplicate identical skills using normalized content hashes.
  const existingHashes = new Set<string>();
  for (const loaded of workspace.packs) {
    for (const skill of loaded.pack?.skills ?? []) {
      existingHashes.add(await hashDirectory(skill.rootDir));
    }
  }

  const skillsWritten: string[] = [];
  const skillsSkippedDuplicates: string[] = [];
  const keptSkills: typeof imported.skills = [];
  for (const skill of imported.skills) {
    // Hash over the imported file set in the same normalized way.
    const material = Object.keys(skill.files)
      .sort()
      .map((rel) => `${rel}:${sha256(skill.files[rel] ?? "")}`)
      .join("\n");
    const hash = `sha256:${sha256(material).slice("sha256:".length)}`;
    if (existingHashes.has(skill.contentHash) || existingHashes.has(hash)) {
      skillsSkippedDuplicates.push(skill.name);
      continue;
    }
    keptSkills.push(skill);
    skillsWritten.push(skill.name);
  }

  if (!opts.dryRun && diagnostics.every((d) => d.severity !== "error")) {
    // Skills
    for (const skill of keptSkills) {
      for (const [rel, content] of Object.entries(skill.files)) {
        const dest = path.join(packDir, "skills", skill.name, ...rel.split("/"));
        await ensureDir(path.dirname(dest));
        await writeFileAtomic(dest, content);
      }
    }
    // Instructions
    for (const instruction of imported.instructions) {
      const dest = path.join(packDir, "instructions", `${instruction.id}.md`);
      await ensureDir(path.dirname(dest));
      await writeFileAtomic(dest, instruction.content);
    }

    // pack.yaml — never contains secret values; importers emit env references.
    const manifest = {
      apiVersion: API_VERSION,
      kind: "Pack",
      metadata: {
        name: packName,
        version: "0.1.0",
        description: `Imported from ${target} (${opts.scope ?? "project"} scope)`,
      },
      spec: {
        skills: keptSkills.map((s) => ({ path: `./skills/${s.name}` })),
        instructions: imported.instructions.map((i) => ({
          id: i.id,
          path: `./instructions/${i.id}.md`,
          scope: i.scope === "global" ? "project" : i.scope,
          priority: 100,
        })),
        mcpServers: imported.mcpServers,
        hooks: [],
        ...(Object.keys(imported.extensions).length > 0
          ? { extensions: { [target]: imported.extensions } }
          : {}),
      },
    };
    await ensureDir(packDir);
    await writeFileAtomic(path.join(packDir, "pack.yaml"), stringifyYaml(manifest));
  }

  return {
    packName,
    packDir,
    skillsWritten,
    skillsSkippedDuplicates,
    mcpServerCount: Object.keys(imported.mcpServers).length,
    instructionCount: imported.instructions.length,
    warnings: imported.warnings,
    diagnostics,
    dryRun: opts.dryRun === true,
  };
}
