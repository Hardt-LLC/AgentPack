import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  API_VERSION,
  findHardcodedSecrets,
  NAME_PATTERN,
  type CanonicalMcpServer,
  type Diagnostic,
  type ImportedConfiguration,
  type PackManifest,
  type Scope,
  type TargetId,
} from "@agentpack/schema";
import {
  ensureDir,
  hashDirectory,
  loadState,
  readFileIfExists,
  sha256,
  writeFileAtomic,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { parsePackManifest, WORKSPACE_FILE, type LoadWorkspaceResult } from "./load-workspace.js";

/**
 * Native change collection: when a user installs MCP servers or skills
 * directly into an agent (plugin menus, manual installs), collect detects
 * them via the target's importer and gathers the delta into a reviewable
 * `packs/inbox-<target>` pack. Inbox packs are referenced by the workspace
 * but NEVER added to a profile, so nothing fans out to other agents until a
 * human promotes the entries.
 */

export interface CollectResult {
  target: TargetId;
  newSkills: string[];
  duplicateSkills: string[];
  newServers: string[];
  skippedServers: Array<{ name: string; reason: string }>;
  packDir: string;
  changed: boolean;
  diagnostics: Diagnostic[];
}

export interface CollectOptions {
  scope?: Scope; // default "user"
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /**
   * Convert literal env/header values that look like secrets into
   * `{ fromEnv: <NAME> }` references. Default false: literals are preserved
   * verbatim (with a warning diagnostic per entry).
   */
  envRefs?: boolean;
}

/** Extract the server name from an adopted config key (json or toml). */
function adoptedServerName(key: {
  jsonPointer?: string;
  tomlTable?: string[];
}): string | undefined {
  if (key.jsonPointer) {
    const segments = key.jsonPointer.split("/").filter((s) => s.length > 0);
    if (segments.length === 2 && segments[0] === "mcpServers") return segments[1];
  }
  if (key.tomlTable && key.tomlTable.length === 2 && key.tomlTable[0] === "mcp_servers") {
    return key.tomlTable[1];
  }
  return undefined;
}

/** Normalize an imported server name into a valid pack.yaml key. */
function sanitizeServerName(name: string, taken: Set<string>): string | undefined {
  if (NAME_PATTERN.test(name) && !taken.has(name)) return name;
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!NAME_PATTERN.test(base)) return undefined;
  let candidate = base;
  for (let i = 2; taken.has(candidate); i += 1) candidate = `${base}-${i}`;
  return candidate;
}

/** Convert a header/env key into an environment variable name. */
function toEnvVarName(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Handle literal env/header values that look like secrets. With
 * `envRefs: true` they are converted to `{ fromEnv: <NAME> }` references so
 * the inbox pack never persists secrets; otherwise the literal is preserved
 * verbatim and a warning is emitted (the value is never printed).
 */
function curateSecrets(
  serverName: string,
  server: Omit<CanonicalMcpServer, "name">,
  diagnostics: Diagnostic[],
  envRefs: boolean,
): Omit<CanonicalMcpServer, "name"> {
  const out = { ...server };
  for (const field of ["env", "headers"] as const) {
    const record = server[field];
    if (!record) continue;
    const next: typeof record = { ...record };
    let touched = false;
    for (const [key, value] of Object.entries(record)) {
      if (!("value" in value)) continue;
      if (findHardcodedSecrets(value.value).length === 0) continue;
      touched = true;
      if (envRefs) {
        const varName = toEnvVarName(key);
        next[key] = { fromEnv: varName };
        diagnostics.push({
          severity: "info",
          message: `server "${serverName}" ${field}.${key}: literal value matches a secret pattern; stored as { fromEnv: ${varName} }`,
        });
      } else {
        diagnostics.push({
          severity: "warning",
          message: `server "${serverName}" ${field}.${key}: possible secret preserved as literal in inbox pack — use --env-refs to convert`,
        });
      }
    }
    if (touched) out[field] = next;
  }
  return out;
}

/** Normalized content hash over an imported skill's in-memory file set. */
function importedSkillHash(skill: ImportedConfiguration["skills"][number]): string {
  const material = Object.keys(skill.files)
    .sort()
    .map((rel) => `${rel}:${sha256(skill.files[rel] ?? "")}`)
    .join("\n");
  return `sha256:${sha256(material).slice("sha256:".length)}`;
}

/**
 * Collect natively-added MCP servers and skills from a target into the
 * workspace's `packs/inbox-<target>` pack. Only the delta against what
 * AgentPack already knows (canonical packs, adopted keys, the gateway entry)
 * is collected; everything else is reported as skipped.
 */
export async function collectFromTarget(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  target: TargetId,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const diagnostics: Diagnostic[] = [];
  const packName = `inbox-${target}`;
  const packDir = path.join(workspace.rootDir, "packs", packName);
  const result: CollectResult = {
    target,
    newSkills: [],
    duplicateSkills: [],
    newServers: [],
    skippedServers: [],
    packDir,
    changed: false,
    diagnostics,
  };

  const adapter = registry.get(target);
  if (!adapter.import) {
    diagnostics.push({ severity: "error", message: `target "${target}" does not support import` });
    return result;
  }

  const imported: ImportedConfiguration = await adapter.import({
    scope: opts.scope ?? "user",
    projectRoot: workspace.rootDir,
    homeDir: opts.homeDir ?? process.env.HOME ?? "",
    env: opts.env ?? process.env,
    options: {},
  });
  for (const warning of imported.warnings) {
    diagnostics.push({ severity: "warning", message: warning });
  }

  // Load the existing inbox pack (if any) so new entries are merged in.
  const packYamlPath = path.join(packDir, "pack.yaml");
  let manifest: PackManifest | undefined;
  const existingYaml = await readFileIfExists(packYamlPath);
  if (existingYaml !== undefined) {
    const parsed = parsePackManifest(existingYaml, packYamlPath);
    if (!parsed.manifest) {
      diagnostics.push({
        severity: "error",
        message: `existing inbox pack is invalid; fix or remove ${packYamlPath}`,
        source: packYamlPath,
      });
      return result;
    }
    manifest = parsed.manifest;
  }

  /* ------------------------------ Known set ----------------------------- */

  // (a) MCP server names across all workspace packs (including this inbox).
  const knownServers = new Map<string, string>(); // lowercased name → reason
  for (const loaded of workspace.packs) {
    for (const name of Object.keys(loaded.pack?.mcpServers ?? {})) {
      knownServers.set(name.toLowerCase(), "already canonical");
    }
  }
  // (b) Servers deliberately adopted from this target's native config.
  const state = await loadState(workspace.rootDir);
  for (const key of state.targets[target]?.adopted?.configKeys ?? []) {
    const name = adoptedServerName(key);
    if (name) knownServers.set(name.toLowerCase(), "adopted");
  }
  // (c) The gateway entry name.
  const gatewayName = (workspace.manifest?.gateway?.name ?? "agentpack").toLowerCase();

  // (d) Content hashes of every skill in every pack.
  const knownSkillHashes = new Set<string>();
  for (const loaded of workspace.packs) {
    for (const skill of loaded.pack?.skills ?? []) {
      knownSkillHashes.add(await hashDirectory(skill.rootDir));
    }
  }

  /* -------------------------------- Delta ------------------------------- */

  const takenNames = new Set<string>([
    ...Object.keys(manifest?.spec.mcpServers ?? {}),
    ...knownServers.keys(),
  ]);
  const newServerEntries: Array<[string, Omit<CanonicalMcpServer, "name">]> = [];
  for (const [name, server] of Object.entries(imported.mcpServers)) {
    const knownReason = knownServers.get(name.toLowerCase());
    if (knownReason) {
      result.skippedServers.push({ name, reason: knownReason });
      continue;
    }
    if (name.toLowerCase() === gatewayName) {
      result.skippedServers.push({ name, reason: "gateway entry" });
      continue;
    }
    const key = sanitizeServerName(name, takenNames);
    if (!key) {
      result.skippedServers.push({ name, reason: "name cannot be normalized to a pack key" });
      continue;
    }
    if (key !== name) {
      diagnostics.push({
        severity: "info",
        message: `server "${name}" renamed to "${key}" (pack keys are lowercase)`,
      });
    }
    takenNames.add(key);
    newServerEntries.push([key, curateSecrets(name, server, diagnostics, opts.envRefs === true)]);
    result.newServers.push(key);
  }

  const keptSkills: ImportedConfiguration["skills"] = [];
  const existingSkillPaths = new Set((manifest?.spec.skills ?? []).map((s) => s.path));
  for (const skill of imported.skills) {
    if (
      knownSkillHashes.has(skill.contentHash) ||
      knownSkillHashes.has(importedSkillHash(skill)) ||
      existingSkillPaths.has(`./skills/${skill.name}`)
    ) {
      result.duplicateSkills.push(skill.name);
      continue;
    }
    keptSkills.push(skill);
    result.newSkills.push(skill.name);
  }

  // Instructions are never collected: plugin instructions are vendor-specific
  // and too noisy to review mechanically.

  result.changed = result.newSkills.length > 0 || result.newServers.length > 0;
  if (opts.dryRun || !result.changed || diagnostics.some((d) => d.severity === "error")) {
    return result;
  }

  /* -------------------------------- Write ------------------------------- */

  for (const skill of keptSkills) {
    for (const [rel, content] of Object.entries(skill.files)) {
      const dest = path.join(packDir, "skills", skill.name, ...rel.split("/"));
      await ensureDir(path.dirname(dest));
      await writeFileAtomic(dest, content);
    }
  }

  const nextManifest: PackManifest =
    manifest ??
    ({
      apiVersion: API_VERSION,
      kind: "Pack",
      metadata: {
        name: packName,
        version: "0.1.0",
        description: `Collected from ${target} native config (review before promoting)`,
      },
      spec: { skills: [], instructions: [], mcpServers: {}, hooks: [] },
    } as PackManifest);
  for (const skill of keptSkills) {
    nextManifest.spec.skills.push({ path: `./skills/${skill.name}` });
  }
  for (const [key, server] of newServerEntries) {
    nextManifest.spec.mcpServers[key] = server;
  }
  await ensureDir(packDir);
  await writeFileAtomic(packYamlPath, stringifyYaml(nextManifest));

  // Ensure agentpack.yaml references the inbox pack (exactly once). The inbox
  // pack is deliberately never added to a profile — that would fan it out.
  const workspaceFile = path.join(workspace.rootDir, WORKSPACE_FILE);
  const workspaceYaml = await fs.readFile(workspaceFile, "utf8");
  if (!workspaceYaml.includes(`./packs/${packName}`)) {
    const entryLine = `  - path: ./packs/${packName}`;
    const lines = workspaceYaml.split("\n");
    const packsIndex = lines.findIndex((line) => /^packs:/.test(line));
    let next: string;
    if (packsIndex >= 0 && /\[\s*\]/.test(lines[packsIndex]!)) {
      lines[packsIndex] = "packs:";
      lines.splice(packsIndex + 1, 0, entryLine);
      next = lines.join("\n");
    } else if (packsIndex >= 0) {
      lines.splice(packsIndex + 1, 0, entryLine);
      next = lines.join("\n");
    } else {
      next = `${workspaceYaml.endsWith("\n") ? workspaceYaml : `${workspaceYaml}\n`}packs:\n${entryLine}\n`;
    }
    await writeFileAtomic(workspaceFile, next);
  }

  return result;
}
