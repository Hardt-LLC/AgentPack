import path from "node:path";
import {
  TARGET_IDS,
  type CapabilityReport,
  type Diagnostic,
  type GeneratedArtifact,
  type Strictness,
  type TargetId,
} from "@agentpack/schema";
import {
  applyOperations,
  ensureDir,
  planOperations,
  type InstallOperation,
} from "@agentpack/filesystem";
import type { AdapterRegistry } from "./registry.js";
import { strictnessDiagnostics } from "./capability.js";
import { buildAdapterContext } from "./detect.js";
import type { LoadWorkspaceResult } from "./load-workspace.js";

export interface BuildResult {
  outputDir: string;
  bundles: Array<{ target: TargetId; pack: string; path: string; files: string[] }>;
  capabilityReports: CapabilityReport[];
  diagnostics: Diagnostic[];
  dryRun: boolean;
}

export interface BuildOptions {
  targets?: TargetId[];
  packs?: string[];
  outputDir?: string;
  strictness?: Strictness;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  /** Adapter-specific options (e.g. kimi pathStrategy). */
  adapterOptions?: Record<string, unknown>;
}

/**
 * Generate native plugin bundles — a pure build step, separate from sync.
 * Output layout: <output>/<target>/<pack-name>/...
 */
export async function buildPlugins(
  workspace: LoadWorkspaceResult,
  registry: AdapterRegistry,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const diagnostics: Diagnostic[] = [...workspace.diagnostics];
  for (const pack of workspace.packs) diagnostics.push(...pack.diagnostics);

  const outputDir = path.resolve(workspace.rootDir, opts.outputDir ?? "dist");
  const targets = opts.targets ?? TARGET_IDS.filter((t) => registry.has(t));
  const capabilityReports: CapabilityReport[] = [];
  const bundles: BuildResult["bundles"] = [];

  for (const target of targets) {
    const adapter = registry.get(target);
    for (const loaded of workspace.packs) {
      const pack = loaded.pack;
      if (!pack) continue;
      if (opts.packs && !opts.packs.includes(pack.metadata.name)) continue;
      if (pack.targetEnabled[target] === false) continue;

      const context = buildAdapterContext(
        adapter,
        undefined,
        "project",
        workspace.rootDir,
        opts.env ?? process.env,
        {
          bundle: true,
          ...(opts.adapterOptions ?? {}),
        },
      );
      const report = await adapter.analyze(pack, context);
      capabilityReports.push(report);

      // Skip bundle generation when the adapter cannot produce plugin
      // bundles (capability model: plugin unsupported for this target).
      // Without this guard, sync-only adapters would write to real config
      // paths because bundleRoot means nothing to them.
      const pluginUnsupported = report.findings.some(
        (f) => f.componentType === "plugin" && f.support === "unsupported",
      );
      if (pluginUnsupported) continue;

      const artifacts: GeneratedArtifact[] = await adapter.generate(pack, context);
      const bundleDir = path.join(outputDir, target, pack.metadata.name);
      const operations = (await adapter.planInstall(artifacts, {
        ...context,
        installMode: "copy",
        symlinksReliable: false,
        bundleRoot: bundleDir,
      })) as InstallOperation[];

      const planned = await planOperations(operations);
      const files = planned.map((p) => p.detail);
      bundles.push({ target, pack: pack.metadata.name, path: bundleDir, files });

      if (!opts.dryRun) {
        await ensureDir(bundleDir);
        await applyOperations(operations);
      }
    }
  }

  diagnostics.push(...strictnessDiagnostics(capabilityReports, opts.strictness ?? "permissive"));

  return { outputDir, bundles, capabilityReports, diagnostics, dryRun: opts.dryRun === true };
}
