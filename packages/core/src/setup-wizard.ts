import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  findHardcodedSecrets,
  NAME_PATTERN,
  type CanonicalPack,
  type Diagnostic,
  type Scope,
  type SecretFinding,
  type TargetId,
} from "@agentpack/schema";
import { loadState, readFileIfExists, saveState, writeFileAtomic } from "@agentpack/filesystem";
import { WORKSPACE_FILE } from "./load-workspace.js";
import { trustRequirement, type TrustRequirement } from "./trust.js";

/**
 * Interactive onboarding (`agentpack setup`) support. The wizard flow lives
 * in the CLI; this module holds the pure-ish step logic — pack curation,
 * secret conversion, workspace/profile edits, trust grants — so the command
 * file stays thin orchestration plus prompts.
 */

/** Convert a header/env key into an environment variable name. */
export function toEnvVarName(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** Normalize an MCP server key to NAME_PATTERN (lowercase, hyphenated). */
function normalizeServerKey(name: string, taken: Set<string>): string | undefined {
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

/* ------------------------------ curatePack ----------------------------- */

export interface CurateSelection {
  /** Original MCP server names to keep. Undefined keeps all. */
  keepServers?: string[];
  /** Skill directory names to keep. Undefined keeps all. */
  keepSkills?: string[];
  /** When false, all instructions are dropped from the manifest. */
  keepInstructions?: boolean;
}

export interface CurateResult {
  keptServers: string[];
  removedServers: string[];
  renamedServers: Array<{ from: string; to: string }>;
  keptSkills: string[];
  removedSkills: string[];
  keptInstructions: string[];
  removedInstructions: string[];
  diagnostics: Diagnostic[];
}

interface RawPackDoc {
  spec?: {
    mcpServers?: Record<string, unknown>;
    skills?: Array<{ path?: string }>;
    instructions?: Array<{ id?: string }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** What the wizard needs to build curation prompts for one pack. */
export interface PackCurationInfo {
  servers: Array<{ name: string; enabled: boolean }>;
  skills: string[];
  instructionCount: number;
  /** Set when pack.yaml could not be parsed at all. */
  parseError?: string;
}

/**
 * Read curation candidates straight from pack.yaml without schema
 * validation — imported packs may not parse (e.g. server names that still
 * need normalization), and those are exactly the packs curation must fix.
 */
export async function readPackCurationInfo(packDir: string): Promise<PackCurationInfo> {
  const info: PackCurationInfo = { servers: [], skills: [], instructionCount: 0 };
  const packYamlPath = path.join(packDir, "pack.yaml");
  let doc: RawPackDoc;
  try {
    doc = (parseYaml(await fs.readFile(packYamlPath, "utf8")) ?? {}) as RawPackDoc;
  } catch (error) {
    return { ...info, parseError: (error as Error).message };
  }
  const spec = doc.spec ?? {};
  for (const [name, server] of Object.entries(spec.mcpServers ?? {})) {
    const enabled =
      typeof server === "object" && server !== null
        ? (server as Record<string, unknown>).enabled !== false
        : true;
    info.servers.push({ name, enabled });
  }
  for (const entry of spec.skills ?? []) {
    if (typeof entry?.path !== "string") continue;
    const name = path.basename(entry.path.replace(/\/+$/, ""));
    if (name) info.skills.push(name);
  }
  info.instructionCount = (spec.instructions ?? []).length;
  return info;
}

/**
 * Apply the wizard's curation choices to a pack on disk: delete unselected
 * MCP servers and skills (skill directories are removed), optionally drop
 * instructions, normalize server keys to lowercase-hyphenated names, and
 * rewrite pack.yaml deterministically.
 */
export async function curatePack(
  packDir: string,
  selection: CurateSelection,
): Promise<CurateResult> {
  const result: CurateResult = {
    keptServers: [],
    removedServers: [],
    renamedServers: [],
    keptSkills: [],
    removedSkills: [],
    keptInstructions: [],
    removedInstructions: [],
    diagnostics: [],
  };

  const packYamlPath = path.join(packDir, "pack.yaml");
  const raw = await fs.readFile(packYamlPath, "utf8");
  const doc = (parseYaml(raw) ?? {}) as RawPackDoc;
  const spec = (doc.spec ?? {}) as NonNullable<RawPackDoc["spec"]>;
  doc.spec = spec;

  /* ------------------------------ MCP servers ---------------------------- */

  const servers = { ...(spec.mcpServers ?? {}) };
  const taken = new Set<string>();
  const nextServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (selection.keepServers && !selection.keepServers.includes(name)) {
      result.removedServers.push(name);
      continue;
    }
    const key = normalizeServerKey(name, taken);
    if (!key) {
      result.removedServers.push(name);
      result.diagnostics.push({
        severity: "warning",
        message: `server "${name}" dropped: name cannot be normalized to a pack key`,
        source: packYamlPath,
      });
      continue;
    }
    if (key !== name) {
      result.renamedServers.push({ from: name, to: key });
      result.diagnostics.push({
        severity: "info",
        message: `server "${name}" renamed to "${key}" (pack keys are lowercase)`,
        source: packYamlPath,
      });
    }
    taken.add(key);
    nextServers[key] = server;
    result.keptServers.push(key);
  }
  spec.mcpServers = nextServers;

  /* -------------------------------- Skills ------------------------------- */

  const skills = Array.isArray(spec.skills) ? spec.skills : [];
  const nextSkills: Array<{ path?: string }> = [];
  for (const entry of skills) {
    const skillPath = typeof entry?.path === "string" ? entry.path : "";
    const name = path.basename(skillPath.replace(/\/+$/, ""));
    if (selection.keepSkills && !selection.keepSkills.includes(name)) {
      result.removedSkills.push(name);
      continue;
    }
    nextSkills.push(entry);
    result.keptSkills.push(name);
  }
  spec.skills = nextSkills;
  for (const name of result.removedSkills) {
    await fs.rm(path.join(packDir, "skills", name), { recursive: true, force: true });
  }

  /* ----------------------------- Instructions ---------------------------- */

  const instructions = Array.isArray(spec.instructions) ? spec.instructions : [];
  if (selection.keepInstructions === false) {
    for (const entry of instructions) {
      result.removedInstructions.push(typeof entry?.id === "string" ? entry.id : "(unknown)");
    }
    spec.instructions = [];
  } else {
    for (const entry of instructions) {
      result.keptInstructions.push(typeof entry?.id === "string" ? entry.id : "(unknown)");
    }
  }

  await writeFileAtomic(packYamlPath, stringifyYaml(doc));
  return result;
}

/* ------------------------ convertSecretsToEnvRefs ----------------------- */

/**
 * Rewrite literal env/header values that look like secrets in a pack.yaml
 * into `{ fromEnv: <NAME> }` references. Only values matching a secret
 * pattern are touched; everything else is preserved verbatim. Returns the
 * number of converted entries (0 = file left untouched).
 */
export async function convertSecretsToEnvRefs(packYamlPath: string): Promise<number> {
  const raw = await fs.readFile(packYamlPath, "utf8");
  const doc = (parseYaml(raw) ?? {}) as RawPackDoc;
  const servers = doc.spec?.mcpServers ?? {};

  let converted = 0;
  for (const server of Object.values(servers)) {
    if (typeof server !== "object" || server === null) continue;
    const record = server as Record<string, unknown>;
    for (const field of ["env", "headers"] as const) {
      const values = record[field];
      if (typeof values !== "object" || values === null) continue;
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.value !== "string") continue;
        if (findHardcodedSecrets(entry.value).length === 0) continue;
        delete entry.value;
        entry.fromEnv = toEnvVarName(key);
        converted += 1;
      }
    }
  }

  if (converted > 0) await writeFileAtomic(packYamlPath, stringifyYaml(doc));
  return converted;
}

/** Count secret-looking literals per pack.yaml (pattern names only, never values). */
export interface PackSecretScan {
  packYamlPath: string;
  findings: SecretFinding[];
}

/** Scan pack.yaml files for hardcoded secrets. Findings never contain values. */
export async function scanPackSecrets(packYamlPaths: string[]): Promise<PackSecretScan[]> {
  const scans: PackSecretScan[] = [];
  for (const packYamlPath of packYamlPaths) {
    const raw = await readFileIfExists(packYamlPath);
    if (raw === undefined) continue;
    const findings = findHardcodedSecrets(raw);
    if (findings.length > 0) scans.push({ packYamlPath, findings });
  }
  return scans;
}

/* --------------------------- workspace file edits ----------------------- */

/** Add `./packs/<name>` to the workspace's packs list (exactly once). */
export async function registerPackInWorkspace(rootDir: string, packName: string): Promise<void> {
  const workspaceFile = path.join(rootDir, WORKSPACE_FILE);
  const raw = await fs.readFile(workspaceFile, "utf8");
  const doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const packs = Array.isArray(doc.packs) ? (doc.packs as Array<Record<string, unknown>>) : [];
  const relPath = `./packs/${packName}`;
  if (!packs.some((entry) => entry?.path === relPath)) {
    packs.push({ path: relPath });
    doc.packs = packs;
    await writeFileAtomic(workspaceFile, stringifyYaml(doc));
  }
}

export interface DefaultProfileSpec {
  /** Pack names to include (unioned with existing profile packs by caller). */
  packs: string[];
  targets: TargetId[];
  scope: Scope;
  /** Enable gateway mode in the workspace manifest. */
  gateway?: boolean;
}

/**
 * Create or update the `default` profile in agentpack.yaml. Existing
 * workspace `packs:` entries and other profiles are preserved; the file is
 * machine-managed, so a YAML reformat is acceptable.
 */
export async function ensureDefaultProfile(
  rootDir: string,
  spec: DefaultProfileSpec,
): Promise<void> {
  const workspaceFile = path.join(rootDir, WORKSPACE_FILE);
  const raw = await fs.readFile(workspaceFile, "utf8");
  const doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const profiles = (doc.profiles ?? {}) as Record<string, unknown>;
  profiles["default"] = {
    packs: spec.packs,
    targets: spec.targets,
    scope: spec.scope,
    installMode: "auto",
  };
  doc.profiles = profiles;
  if (spec.gateway) {
    const gateway = (doc.gateway ?? {}) as Record<string, unknown>;
    gateway.enabled = true;
    doc.gateway = gateway;
  }
  await writeFileAtomic(workspaceFile, stringifyYaml(doc));
}

/* ------------------------------- trust --------------------------------- */

/**
 * Record a trust grant for a pack's current executable content in the
 * workspace state — the same record `agentpack promote` writes, so a later
 * sync needs no `--trust` flag.
 */
export async function grantPackTrust(
  rootDir: string,
  pack: CanonicalPack,
): Promise<TrustRequirement> {
  const requirement = await trustRequirement(pack);
  const state = await loadState(rootDir);
  state.trust = state.trust ?? {};
  state.trust[pack.metadata.name] = {
    contentHash: requirement.contentHash,
    grantedAt: new Date().toISOString(),
  };
  await saveState(rootDir, state);
  return requirement;
}
