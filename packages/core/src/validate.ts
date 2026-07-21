import {
  collectEnvVars,
  TARGET_IDS,
  type CapabilityReport,
  type Diagnostic,
  type Strictness,
  type TargetId,
} from "@agentpack/schema";
import type { AdapterRegistry } from "./registry.js";
import { strictnessDiagnostics } from "./capability.js";
import { resolveSelection, type SelectionOverrides } from "./profiles.js";
import { buildAdapterContext, type DetectedTargets } from "./detect.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface ValidationResult {
  diagnostics: Diagnostic[];
  capabilityReports: CapabilityReport[];
  ok: boolean;
}

export interface ValidateOptions extends SelectionOverrides {
  strictness?: Strictness;
  env?: Record<string, string | undefined>;
  /** Adapter-specific options (e.g. kimi pathStrategy). */
  adapterOptions?: Record<string, unknown>;
}

/**
 * Full workspace validation: schemas and skills (already collected during
 * loading), cross-pack duplicates, MCP env references, destination
 * conflicts, and per-target capability compatibility.
 */
export async function validateWorkspace(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  detected: DetectedTargets,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const diagnostics: Diagnostic[] = [...workspace.diagnostics];
  for (const pack of workspace.packs) diagnostics.push(...pack.diagnostics);

  const selection = resolveSelection(workspace, opts, registry.ids());
  diagnostics.push(...selection.diagnostics);
  const env = opts.env ?? process.env;

  // Cross-pack duplicate skill names targeting the same agent.
  const skillOwners = new Map<string, string>();
  for (const pack of selection.packs) {
    for (const skill of pack.skills) {
      const owner = skillOwners.get(skill.name);
      if (owner && owner !== pack.metadata.name) {
        diagnostics.push({
          severity: "error",
          message: `skill "${skill.name}" is provided by both "${owner}" and "${pack.metadata.name}"`,
          source: pack.rootDir,
        });
      }
      skillOwners.set(skill.name, pack.metadata.name);
    }
  }

  // MCP servers: env references + conflicting destinations per target.
  const mcpOwners = new Map<string, { pack: string; json: string }>();
  for (const pack of selection.packs) {
    for (const [name, server] of Object.entries(pack.mcpServers)) {
      const missing = collectEnvVars({ ...(server.env ?? {}), ...(server.headers ?? {}) })
        .concat(server.passEnv ?? [])
        .filter((varName) => env[varName] === undefined);
      for (const varName of new Set(missing)) {
        diagnostics.push({
          severity: "warning",
          message: `environment variable not set: ${varName} (referenced by mcp:${name}) — name only, value never read`,
          source: pack.rootDir,
        });
      }
      const fingerprint = JSON.stringify({ ...server, name: undefined });
      const existing = mcpOwners.get(name);
      if (existing) {
        if (existing.json !== fingerprint) {
          diagnostics.push({
            severity: "error",
            message: `conflicting MCP server "${name}" defined by "${existing.pack}" and "${pack.metadata.name}" with different configuration`,
            source: pack.rootDir,
          });
        }
      } else {
        mcpOwners.set(name, { pack: pack.metadata.name, json: fingerprint });
      }
    }
  }

  // Capability analysis per selected target.
  const capabilityReports: CapabilityReport[] = [];
  const targets: TargetId[] = selection.targets;
  for (const target of targets) {
    if (!registry.has(target)) {
      diagnostics.push({
        severity: "error",
        message: `no adapter registered for target "${target}"`,
      });
      continue;
    }
    const adapter = registry.get(target);
    const detection = detected[target];
    for (const pack of selection.packs) {
      if (pack.targetEnabled[target] === false) continue;
      const context = buildAdapterContext(
        adapter,
        detection,
        selection.scope,
        workspace.rootDir,
        env,
        opts.adapterOptions ?? {},
      );
      const report = await adapter.analyze(pack, context);
      capabilityReports.push(report);
    }
  }
  diagnostics.push(...strictnessDiagnostics(capabilityReports, opts.strictness ?? "permissive"));

  return {
    diagnostics,
    capabilityReports,
    ok: !diagnostics.some((d) => d.severity === "error"),
  };
}
