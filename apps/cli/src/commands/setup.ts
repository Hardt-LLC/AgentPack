import path from "node:path";

import * as p from "@clack/prompts";
import type { Command } from "commander";

import {
  convertSecretsToEnvRefs,
  curatePack,
  detectTargets,
  ensureDefaultProfile,
  findWorkspaceRoot,
  formatTrustSummary,
  grantPackTrust,
  importFromTarget,
  installCollectHook,
  installService,
  loadWorkspace,
  readPackCurationInfo,
  registerPackInWorkspace,
  requiresTrust,
  scanPackSecrets,
  setupGateway,
  syncWorkspace,
  trustRequirement,
  type LoadWorkspaceResult,
} from "@agentpack/core";
import { pathExists } from "@agentpack/filesystem";
import { TARGET_IDS, type Scope, type TargetId } from "@agentpack/schema";

import type { GlobalOptions } from "../context.js";
import { CliError, ExitSignal } from "../errors.js";
import { createWorkspace } from "./init.js";
import { defaultRegistry } from "../registry.js";

/** Absolute path of the running CLI bundle, used in service/hook/gateway launchers. */
function cliPath(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new CliError("cannot determine CLI path for launchers", 2);
  return path.resolve(argv1);
}

/** Control-flow marker: user cancelled a prompt (Ctrl-C / Esc). */
class SetupCancelled extends Error {}

interface SetupOptions {
  yes?: boolean;
}

/**
 * Interactive onboarding wizard. All decisions funnel through the `*Step`
 * wrappers: with --yes they take the default and log it; otherwise they ask
 * via @clack/prompts. Every mutation after a prompt comes from core, so a
 * Ctrl-C mid-wizard never leaves a half-answered step applied.
 */
export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("interactive onboarding: workspace, import, curate, sync, automation")
    .option("--yes", "accept all defaults (non-interactive)")
    .action(async (options: SetupOptions) => {
      const yes = options.yes === true;
      if (!yes && !process.stdin.isTTY) {
        throw new CliError(
          "agentpack setup is interactive — re-run with --yes in a non-interactive environment",
          2,
        );
      }

      const check = <T>(value: T | symbol): T => {
        if (p.isCancel(value)) throw new SetupCancelled();
        return value;
      };

      const confirmStep = async (message: string, initialValue: boolean): Promise<boolean> => {
        if (yes) {
          p.log.info(`${message} → ${initialValue ? "yes" : "no"} (default)`);
          return initialValue;
        }
        return check(await p.confirm({ message, initialValue }));
      };

      const selectStep = async <T extends string>(
        message: string,
        options: Array<{ value: T; label: string; hint?: string }>,
        initialValue: T,
      ): Promise<T> => {
        if (yes) {
          p.log.info(`${message} → ${initialValue} (default)`);
          return initialValue;
        }
        // clack's Option<Value> is a conditional type that TS cannot check
        // against a generic T — cast to the concrete string shape.
        const concrete = options as Array<{ value: string; label?: string; hint?: string }>;
        return check(await p.select({ message, options: concrete, initialValue })) as T;
      };

      const multiselectStep = async <T extends string>(
        message: string,
        options: Array<{ value: T; label: string; hint?: string }>,
        initialValues: T[],
      ): Promise<T[]> => {
        if (yes) {
          p.log.info(`${message} → ${initialValues.join(", ") || "(none)"} (default)`);
          return initialValues;
        }
        const concrete = options as Array<{ value: string; label?: string; hint?: string }>;
        return check(
          await p.multiselect({
            message,
            options: concrete,
            initialValues,
            required: false,
          }),
        ) as T[];
      };

      const textStep = async (message: string, initialValue: string): Promise<string> => {
        if (yes) {
          p.log.info(`${message} → ${initialValue} (default)`);
          return initialValue;
        }
        return check(await p.text({ message, initialValue }));
      };

      try {
        await runSetup(program.opts<GlobalOptions>(), yes, {
          confirmStep,
          selectStep,
          multiselectStep,
          textStep,
        });
        throw new ExitSignal(0);
      } catch (error) {
        if (error instanceof SetupCancelled) {
          p.cancel("Setup cancelled — no changes made beyond what was already applied.");
          throw new ExitSignal(0);
        }
        throw error;
      }
    });
}

interface Steps {
  confirmStep: (message: string, initialValue: boolean) => Promise<boolean>;
  selectStep: <T extends string>(
    message: string,
    options: Array<{ value: T; label: string; hint?: string }>,
    initialValue: T,
  ) => Promise<T>;
  multiselectStep: <T extends string>(
    message: string,
    options: Array<{ value: T; label: string; hint?: string }>,
    initialValues: T[],
  ) => Promise<T[]>;
  textStep: (message: string, initialValue: string) => Promise<string>;
}

async function runSetup(global: GlobalOptions, yes: boolean, steps: Steps): Promise<void> {
  const registry = defaultRegistry();

  p.intro("AgentPack setup — from zero to synced in a few steps");

  /* --------------------------- 2. workspace ----------------------------- */

  const explicitRoot = global.workspace ? path.resolve(global.workspace) : undefined;
  let root: string;
  const candidate = explicitRoot ?? (await findWorkspaceRoot(process.cwd()));
  if (candidate && (await pathExists(path.join(candidate, "agentpack.yaml")))) {
    const use = await steps.confirmStep(`Use workspace at ${candidate}?`, true);
    if (use) {
      root = candidate;
    } else {
      root = await createWorkspaceStep(steps);
    }
  } else if (explicitRoot) {
    const written = await createWorkspace(explicitRoot);
    root = explicitRoot;
    p.log.success(`Created AgentPack workspace in ${root} (${written.length} files)`);
  } else {
    root = await createWorkspaceStep(steps);
  }

  /* --------------------------- 3. detection ----------------------------- */

  const detected = await detectTargets(registry, root, {});
  const detectionLines = TARGET_IDS.map(
    (target) =>
      `${target}: ${
        detected[target]?.installed
          ? `installed${detected[target]?.version ? ` (${detected[target]?.version})` : ""}`
          : "not found — will still configure"
      }`,
  );
  p.note(detectionLines.join("\n"), "Detected agents");

  /* ----------------------------- 4. import ------------------------------ */

  const importable = TARGET_IDS.filter((target) => registry.get(target).import !== undefined);
  const detectedTargets = importable.filter((target) => detected[target]?.installed);
  const importTargets =
    importable.length === 0
      ? []
      : await steps.multiselectStep(
          "Import existing config from which agents?",
          importable.map((target) => ({
            value: target,
            label: target,
            hint: detected[target]?.installed ? undefined : "not detected",
          })),
          detectedTargets,
        );

  const importedPacks: Array<{ name: string; dir: string }> = [];
  for (const target of importTargets) {
    const spinner = p.spinner();
    spinner.start(`Importing from ${target}`);
    const workspace = await loadWorkspace(root);
    const result = await importFromTarget(workspace, registry, target, { scope: "user" });
    const count = result.mcpServerCount + result.skillsWritten.length + result.instructionCount;
    if (count === 0) {
      spinner.stop(`${target}: nothing found`);
      // importFromTarget writes the pack directory even when empty — clean it up.
      if (result.packDir) {
        const { rm } = await import("node:fs/promises");
        await rm(result.packDir, { recursive: true, force: true });
      }
      continue;
    }
    spinner.stop(
      `${target}: imported ${result.mcpServerCount} server(s), ` +
        `${result.skillsWritten.length} skill(s), ${result.instructionCount} instruction(s)`,
    );
    if (result.packName) {
      await registerPackInWorkspace(root, result.packName);
      importedPacks.push({ name: result.packName, dir: result.packDir });
    }
  }

  /* ----------------------------- 5. curation ---------------------------- */

  if (importedPacks.length > 0) {
    for (const imported of importedPacks) {
      // Read raw pack.yaml (not the validated manifest): imported packs may
      // not parse yet — e.g. server names that curation must normalize.
      const info = await readPackCurationInfo(imported.dir);
      if (info.parseError) {
        p.log.warn(`[${imported.name}] cannot read pack.yaml: ${info.parseError}`);
        continue;
      }

      let keepServers: string[] | undefined;
      if (info.servers.length > 0) {
        keepServers = await steps.multiselectStep(
          `[${imported.name}] MCP servers to keep`,
          info.servers.map((server) => ({
            value: server.name,
            label: server.name,
            hint: server.enabled ? undefined : "(disabled)",
          })),
          info.servers.filter((server) => server.enabled).map((server) => server.name),
        );
      }

      let keepSkills: string[] | undefined;
      if (info.skills.length > 0) {
        keepSkills = await steps.multiselectStep(
          `[${imported.name}] skills to keep`,
          info.skills.map((name) => ({ value: name, label: name })),
          info.skills,
        );
      }

      const keepInstructions =
        info.instructionCount === 0
          ? undefined
          : await steps.confirmStep(
              `[${imported.name}] keep ${info.instructionCount} imported instruction(s)?`,
              true,
            );

      const curated = await curatePack(imported.dir, {
        keepServers,
        keepSkills,
        keepInstructions,
      });
      for (const diagnostic of curated.diagnostics) {
        if (diagnostic.severity === "info") p.log.info(diagnostic.message);
        else p.log.warn(diagnostic.message);
      }
      if (curated.removedServers.length > 0) {
        p.log.info(`[${imported.name}] removed servers: ${curated.removedServers.join(", ")}`);
      }
      if (curated.removedSkills.length > 0) {
        p.log.info(`[${imported.name}] removed skills: ${curated.removedSkills.join(", ")}`);
      }
    }

    // Surface packs that still fail to load after curation.
    const workspace = await loadWorkspace(root);
    for (const loaded of workspace.packs) {
      for (const diagnostic of loaded.diagnostics) {
        if (diagnostic.severity === "error") {
          p.log.warn(`[${importedPacks.map((i) => i.name).join(", ")}] ${diagnostic.message}`);
        }
      }
    }
  }

  /* ----------------------------- 6. secrets ----------------------------- */

  const packYamlPaths = importedPacks.map((pack) => path.join(pack.dir, "pack.yaml"));
  const secretScans = await scanPackSecrets(packYamlPaths);
  const secretCount = secretScans.reduce((sum, scan) => sum + scan.findings.length, 0);
  if (secretCount > 0) {
    const patterns = [
      ...new Set(secretScans.flatMap((scan) => scan.findings.map((f) => f.pattern))),
    ];
    p.log.warn(
      `Found ${secretCount} secret-looking literal(s) in imported config (patterns: ${patterns.join(", ")})`,
    );
    const handling = await steps.selectStep(
      "How to handle literal secrets found in imported config?",
      [
        { value: "keep", label: "Keep as literals (local machine only)" },
        { value: "convert", label: "Convert to environment references ({ fromEnv })" },
      ],
      "keep",
    );
    if (handling === "convert") {
      for (const packYamlPath of packYamlPaths) {
        const converted = await convertSecretsToEnvRefs(packYamlPath);
        if (converted > 0) {
          p.log.success(
            `${path.basename(path.dirname(packYamlPath))}: converted ${converted} value(s) to { fromEnv }`,
          );
        }
      }
    }
  } else {
    p.log.info("No secret-looking literals found in imported config");
  }

  /* ------------------------------ 7. scope ------------------------------ */

  const scope = await steps.selectStep<Scope>(
    "Install scope?",
    [
      { value: "user", label: "user — available in every project" },
      { value: "project", label: "project — this workspace only" },
    ],
    "user",
  );

  /* --------------------------- 8. MCP delivery -------------------------- */

  const delivery = await steps.selectStep(
    "MCP delivery mode?",
    [
      {
        value: "gateway",
        label: "Gateway (recommended): one agentpack entry per agent, live fan-out",
      },
      { value: "individual", label: "Individual entries per agent" },
    ],
    "gateway",
  );
  const gatewayEnabled = delivery === "gateway";

  /* ----------------------------- 9. profile ----------------------------- */

  const profileTargets: TargetId[] = detectedTargets.length > 0 ? detectedTargets : [...importable];
  const existingProfilePacks =
    (await loadWorkspace(root)).manifest?.profiles["default"]?.packs ?? [];
  const profilePacks = [...new Set([...existingProfilePacks, ...importedPacks.map((p) => p.name)])];
  await ensureDefaultProfile(root, {
    packs: profilePacks,
    targets: profileTargets,
    scope,
    gateway: gatewayEnabled,
  });
  p.log.success(
    `default profile: packs [${profilePacks.join(", ") || "none"}], ` +
      `targets [${profileTargets.join(", ")}], scope ${scope}`,
  );

  /* ------------------------------ 10. trust ----------------------------- */

  const trustedPacks: string[] = [];
  const excludedPacks: string[] = [];
  {
    const workspace = await loadWorkspace(root);
    for (const packName of profilePacks) {
      const pack = workspace.packs.find((entry) => entry.pack?.metadata.name === packName)?.pack;
      if (!pack) {
        p.log.warn(
          `pack "${packName}" could not be loaded — it will fail at sync; run \`agentpack validate\``,
        );
        continue;
      }
      const requirement = await trustRequirement(pack);
      if (!requiresTrust(requirement)) {
        trustedPacks.push(packName);
        continue;
      }
      p.note(formatTrustSummary(requirement), `Trust: ${packName}`);
      // Interactive default is "no" for safety. Under --yes we trust the
      // packs the run just imported/curated — declining non-interactively
      // would silently produce an empty setup.
      const trust = yes ? true : await steps.confirmStep(`Trust ${packName}?`, false);
      if (yes) p.log.info(`Trust ${packName}? → yes (--yes)`);
      if (trust) {
        await grantPackTrust(root, pack);
        trustedPacks.push(packName);
        p.log.info(`trust granted for ${packName}`);
      } else {
        excludedPacks.push(packName);
      }
    }
  }
  let finalProfilePacks = profilePacks;
  if (excludedPacks.length > 0) {
    p.log.warn(
      `excluded untrusted pack(s) from the profile: ${excludedPacks.join(", ")} ` +
        "(promote later with `agentpack promote <pack>`)",
    );
    finalProfilePacks = profilePacks.filter((name) => !excludedPacks.includes(name));
    await ensureDefaultProfile(root, {
      packs: finalProfilePacks,
      targets: profileTargets,
      scope,
      gateway: gatewayEnabled,
    });
  }

  /* ------------------------------ 11. apply ----------------------------- */

  const applyWorkspace = await loadWorkspace(root);
  const spinner = p.spinner();
  spinner.start("Syncing packs into native config");
  // adopt:true — importing from an agent and syncing back to the same scope
  // means the original unmanaged files stand where managed ones go; they are
  // moved into the backup (restorable via `agentpack uninstall`).
  const syncResult = await syncWorkspace(applyWorkspace, registry, { trust: [], adopt: true });
  if (syncResult.trustRefusals.length > 0 || syncResult.conflicts.length > 0) {
    spinner.stop("Sync aborted");
    for (const refusal of syncResult.trustRefusals) {
      p.log.error(`trust refusal [${refusal.requirement.pack}]: ${refusal.reason}`);
    }
    for (const conflict of syncResult.conflicts) {
      p.log.error(`conflict [${conflict.target}] ${conflict.path}: ${conflict.reason}`);
    }
    p.log.error(
      "Apply aborted — resolve the above and run `agentpack sync` " +
        "(or `agentpack sync --force` to overwrite externally modified files).",
    );
    throw new ExitSignal(3);
  }
  if (!syncResult.applied || syncResult.diagnostics.some((d) => d.severity === "error")) {
    spinner.stop("Sync aborted");
    for (const diagnostic of syncResult.diagnostics) {
      if (diagnostic.severity === "error") p.log.error(diagnostic.message);
    }
    p.log.error("Apply aborted — fix the workspace errors above, then run `agentpack sync`.");
    throw new ExitSignal(1);
  }
  const changeCount = syncResult.plan.targets.reduce(
    (sum, targetPlan) =>
      sum +
      targetPlan.operations.filter((op) => op.action !== "noop").length +
      targetPlan.removals.filter((op) => op.action !== "noop").length,
    0,
  );
  spinner.stop(
    `Sync applied: ${changeCount} change(s)` +
      (syncResult.backupId ? ` (backup: ${syncResult.backupId})` : ""),
  );

  let gatewayInstalled = 0;
  let gatewayAdopted = 0;
  if (gatewayEnabled) {
    const gatewayResult = await setupGateway(await loadWorkspace(root), registry, {
      adopt: true,
      cliPath: cliPath(),
    });
    gatewayInstalled = gatewayResult.installed.length;
    gatewayAdopted = gatewayResult.adoptedKeys.length;
    p.log.success(
      `gateway: ${gatewayResult.serverCount} server(s), ` +
        `${gatewayInstalled} entry(ies) installed, ${gatewayAdopted} adopted`,
    );
  }

  /* ---------------------------- 12. automation -------------------------- */

  let serviceInstalled = false;
  if (await steps.confirmStep("Run AgentPack in the background at login?", true)) {
    const info = await installService({ workspaceRoot: root, cliPath: cliPath() });
    serviceInstalled = true;
    p.log.success(`service file: ${info.filePath}`);
    if (info.warning) p.log.warn(info.warning);
  }

  let hookInstalled = false;
  if (
    detected.claude?.installed &&
    (await steps.confirmStep("Collect new installs at every Claude session start?", true))
  ) {
    const hookResult = await installCollectHook(await loadWorkspace(root), registry, {
      target: "claude",
      cliPath: cliPath(),
    });
    hookInstalled = hookResult.installed;
    p.log.success(hookResult.message);
  }

  /* ------------------------------ 13. outro ----------------------------- */

  const finalCounts = countProfileComponents(applyWorkspace, finalProfilePacks);
  p.note(
    [
      `packs: ${finalProfilePacks.join(", ") || "(none)"}`,
      `servers: ${finalCounts.servers}`,
      `skills: ${finalCounts.skills}`,
      `targets: ${profileTargets.join(", ")}`,
      `gateway: ${gatewayEnabled ? "on" : "off"}`,
      `service installed: ${serviceInstalled ? "yes" : "no"}`,
      `claude collect hook: ${hookInstalled ? "yes" : "no"}`,
    ].join("\n"),
    "Setup complete",
  );
  p.outro(
    "Next: `agentpack watch --collect` (or the service does it), `agentpack list`, " +
      "`agentpack promote inbox-<target>` when new installs are collected.",
  );
}

async function createWorkspaceStep(steps: Steps): Promise<string> {
  const dir = await steps.textStep("Workspace directory", "./agent-config");
  const root = path.resolve(dir.trim().length > 0 ? dir : "./agent-config");
  if (await pathExists(path.join(root, "agentpack.yaml"))) {
    p.log.info(`Using existing workspace at ${root}`);
    return root;
  }
  const written = await createWorkspace(root);
  p.log.success(`Created AgentPack workspace in ${root} (${written.length} files)`);
  return root;
}

function countProfileComponents(
  workspace: LoadWorkspaceResult,
  packNames: string[],
): { servers: number; skills: number } {
  let servers = 0;
  let skills = 0;
  for (const name of packNames) {
    const pack = workspace.packs.find((entry) => entry.pack?.metadata.name === name)?.pack;
    if (!pack) continue;
    servers += Object.keys(pack.mcpServers).length;
    skills += pack.skills.length;
  }
  return { servers, skills };
}
