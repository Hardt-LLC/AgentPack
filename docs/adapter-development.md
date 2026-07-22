# Adapter development

A target adapter teaches AgentPack one more native agent. Adapters implement
the `TargetAdapter` contract from `packages/schema/adapter.ts`, are pure
compilers (they return data, never write files), and are registered in an
`AdapterRegistry` that the core and the CLI consume.

## The contract

```ts
export interface TargetAdapter {
  readonly id: TargetId;

  detect(context: DetectionContext): Promise<TargetDetection>;
  analyze(pack: CanonicalPack, context: AdapterContext): Promise<CapabilityReport>;
  generate(pack: CanonicalPack, context: AdapterContext): Promise<GeneratedArtifact[]>;
  planInstall(
    artifacts: GeneratedArtifact[],
    context: InstallContext,
  ): Promise<InstallOperationLike[]>;
  import?(context: ImportContext): Promise<ImportedConfiguration>;
}
```

Method contracts:

- **`detect`** — best-effort detection. **Must never throw when the agent is
  absent**: a missing executable means `installed: false`, a failed version
  probe becomes a warning. Always fill in `userConfigRoot` and
  `projectConfigRoot` — they are used as defaults by `planInstall` even when
  nothing is installed. Use `context.findExecutable` (injectable) rather than
  your own PATH scan, so tests can fake installations.
- **`analyze`** — classify **every** component of the pack for this target:
  each skill, each enabled MCP server, each instruction, the plugin, each
  hook, and any extension data you define. Return a `CapabilityReport` with
  one finding per component. This is called by `validate`, `plan`, `sync`, and
  `build`, and drives the strictness modes — never throw for an unsupported
  component, report it.
- **`generate`** — emit native artifacts as **pure data**. No filesystem
  writes, no reads that affect the output shape beyond the pack itself.
  Artifacts carry a logical `root` (`projectConfig` | `userConfig` |
  `bundle`), not absolute paths. When `context.options.bundle === true`, emit
  a self-contained plugin-bundle layout under the `bundle` root instead of
  config-root artifacts (this powers `agentpack build`).
- **`planInstall`** — convert artifacts into installer operations with
  absolute paths. Honor `context.installMode` (`symlink` vs `copy` for skill
  directories, via `context.symlinksReliable` in `auto`), the scope's config
  roots (prefer `context.detection.*ConfigRoot`, fall back to your defaults),
  adapter options from `context.options`, and `context.bundleRoot` for bundle
  artifacts (throw if a bundle artifact arrives without one).
- **`import?`** — optional and **read-only**: parse the agent's existing
  native configuration back into canonical form (`skills`, `mcpServers`,
  `instructions`, target-specific `extensions`, `warnings`). Render secret
  strings back as `fromEnv`/`template` references so imported manifests never
  contain secret values. The source configuration must not be modified.
- **`nativeSources?`** — optional, used by collection (`agentpack collect`
  and `watch --collect`): return the user-scope paths (files or directories)
  that should be watched for natively-installed changes — typically the
  agent's MCP config file and its skills directory. Paths do not need to
  exist. Implementing `import` enables one-shot collection; adding
  `nativeSources` enables continuous collection.

The filesystem rule is absolute: **adapters return data; the shared installer
(`packages/filesystem`) is the only code that writes.**

## Artifacts and install operations

`GeneratedArtifact` is a tagged union; `planInstall` translates each kind into
the corresponding `InstallOperationLike`:

| Artifact kind      | Fields                                               | Operation                          |
| ------------------ | ---------------------------------------------------- | ---------------------------------- |
| `file`             | `root`, `relPath`, `content`, `executable?`          | `writeFile`                        |
| `skill`            | `root`, `name`, `sourceDir` (absolute), `relPath`    | `createSymlink` or `copyDirectory` |
| `json-merge`       | `root`, `relPath`, `pointer`, `value`                | `mergeJson` (object keys only)     |
| `toml-merge`       | `root`, `relPath`, `table: string[]`, `value`        | `mergeToml`                        |
| `markdown-section` | `root`, `relPath`, `sectionId`, `content`, `append?` | `managedMarkdownSection`           |

The remaining operation, `removeOwnedPath`, is emitted by the core planner for
stale owned paths — adapters never produce it.

## Capability levels

Choose the lowest honest level; users select strictness (`permissive`,
`strict`, `portable`) and degraded/unsupported findings become warnings or
errors accordingly.

- **`native`** — the target represents the component 1:1. Example: a skill for
  any target that has a skills directory.
- **`transpiled`** — rendered into a different but equivalent native form.
  Example: canonical hooks → Claude `settings.json` hook entries; an `http`
  MCP server → Codex `config.toml` fields.
- **`degraded`** — rendered with loss, or silently dropped in part. Always
  include `message` and preferably `remediation`. Example: `passEnv` dropped
  for Claude (remediation: declare `env` with `fromEnv`).
- **`unsupported`** — cannot be represented at all; nothing is emitted.
  Example: hooks for Codex.

A single component can produce several findings (e.g. an MCP server that is
`native` overall but `degraded` for its `allowTools`).

## A minimal complete adapter: `zedcode`

A hypothetical agent "Zed Code": executable `zed`, user config at
`~/.zedcode`, project config at `<project>/.zedcode`. It supports skills
natively and instructions as managed sections in `ZED.md`; it has no hook
system and no MCP support. Real TypeScript against the actual contract:

```ts
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterContext,
  CanonicalPack,
  CapabilityFinding,
  CapabilityReport,
  DetectionContext,
  GeneratedArtifact,
  InstallContext,
  InstallOperationLike,
  TargetAdapter,
  TargetDetection,
} from "@agentpack/schema";

const execFileAsync = promisify(execFile);

function userConfigRoot(homeDir: string): string {
  return path.join(homeDir, ".zedcode");
}
function projectConfigRoot(projectRoot: string): string {
  return path.join(projectRoot, ".zedcode");
}

export function createZedcodeAdapter(): TargetAdapter {
  return {
    // NOTE: TargetId is a closed enum ("codex" | "claude" | "kimi") in the
    // MVP schema; a third-party id requires widening targetIdSchema.
    id: "zedcode" as never,

    async detect(context: DetectionContext): Promise<TargetDetection> {
      const warnings: string[] = [];
      const roots = {
        userConfigRoot: userConfigRoot(context.homeDir),
        projectConfigRoot: projectConfigRoot(context.projectRoot),
      };
      const executablePath = context.findExecutable
        ? await context.findExecutable("zed")
        : undefined;
      if (!executablePath) return { installed: false, warnings, ...roots };

      let version: string | undefined;
      try {
        const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
          timeout: 5000,
        });
        version = /(\d+\.\d+(?:\.\d+)?)/.exec((stdout || stderr).trim())?.[1];
      } catch {
        warnings.push(`failed to run \`zed --version\` (${executablePath})`);
      }
      return { installed: true, executablePath, version, warnings, ...roots };
    },

    analyze(pack: CanonicalPack, _context: AdapterContext): Promise<CapabilityReport> {
      const findings: CapabilityFinding[] = [];
      for (const skill of pack.skills) {
        findings.push({
          target: "zedcode" as never,
          componentType: "skill",
          componentId: skill.name,
          support: "native",
        });
      }
      for (const instruction of pack.instructions) {
        findings.push({
          target: "zedcode" as never,
          componentType: "instruction",
          componentId: instruction.id,
          support: "native",
        });
      }
      for (const server of Object.values(pack.mcpServers)) {
        if (server.enabled === false) continue;
        findings.push({
          target: "zedcode" as never,
          componentType: "mcp",
          componentId: server.name,
          support: "unsupported",
          message: "Zed Code has no MCP support",
        });
      }
      for (const hook of pack.hooks) {
        findings.push({
          target: "zedcode" as never,
          componentType: "hook",
          componentId: hook.id,
          support: "unsupported",
          message: "Zed Code has no hook system",
        });
      }
      return Promise.resolve({ findings });
    },

    generate(pack: CanonicalPack, context: AdapterContext): Promise<GeneratedArtifact[]> {
      const artifacts: GeneratedArtifact[] = [];
      const root = context.scope === "project" ? "projectConfig" : "userConfig";

      for (const skill of pack.skills) {
        artifacts.push({
          kind: "skill",
          root,
          name: skill.name,
          sourceDir: skill.rootDir,
          relPath: `skills/${skill.name}`,
        });
      }
      for (const instruction of pack.instructions) {
        artifacts.push({
          kind: "markdown-section",
          root,
          relPath: "ZED.md",
          sectionId: instruction.id,
          content: instruction.content,
          append: instruction.mergeStrategy === "append" ? true : undefined,
        });
      }
      // MCP servers and hooks are unsupported (see analyze) — emit nothing.
      return Promise.resolve(artifacts);
    },

    planInstall(
      artifacts: GeneratedArtifact[],
      context: InstallContext,
    ): Promise<InstallOperationLike[]> {
      const useSymlink =
        context.installMode === "symlink" ||
        (context.installMode === "auto" && context.symlinksReliable);
      const base = (root: string): string =>
        root === "projectConfig"
          ? context.detection.projectConfigRoot || projectConfigRoot(context.projectRoot)
          : context.detection.userConfigRoot || userConfigRoot(context.homeDir);

      const ops: InstallOperationLike[] = [];
      for (const artifact of artifacts) {
        if (artifact.root === "bundle") {
          throw new Error("zedcode adapter does not support plugin bundles");
        }
        const dest = path.join(base(artifact.root), artifact.relPath);
        switch (artifact.kind) {
          case "skill":
            ops.push(
              useSymlink
                ? { type: "createSymlink", path: dest, target: artifact.sourceDir }
                : { type: "copyDirectory", source: artifact.sourceDir, dest },
            );
            break;
          case "markdown-section":
            ops.push({
              type: "managedMarkdownSection",
              path: dest,
              sectionId: artifact.sectionId,
              content: artifact.content,
              append: artifact.append,
            });
            break;
          case "file":
            ops.push({
              type: "writeFile",
              path: dest,
              content: artifact.content,
              executable: artifact.executable,
            });
            break;
          case "json-merge":
            ops.push({
              type: "mergeJson",
              path: dest,
              pointer: artifact.pointer,
              value: artifact.value,
            });
            break;
          case "toml-merge":
            ops.push({
              type: "mergeToml",
              path: dest,
              table: artifact.table,
              value: artifact.value,
            });
            break;
        }
      }
      return Promise.resolve(ops);
    },
  };
}
```

## The simple-adapter factory

Most targets do not need a hand-written adapter. `packages/adapter-ext` ships
15 adapters (cursor, windsurf, cline, roo, kilo, copilot-vscode, copilot-cli,
gemini, antigravity, opencode, openclaw, pi, hermes, vibe, droid) built from
one declarative factory:

```ts
import { defineSimpleAdapter, type SimpleAdapterSpec } from "@agentpack/adapter-ext";
```

**Use `defineSimpleAdapter` when** the target is sync-oriented and its native
surface is: a JSON / JSONC / YAML / TOML MCP config file, markdown instruction
files, and (optionally) a skills directory. The factory derives `detect`,
`analyze`, `generate`, `planInstall`, `import`, and `nativeSources` from the
spec — including capability findings (missing skills directory → `unsupported`
skills, user-scope-only MCP → `degraded` at project scope, plugins always
`unsupported`). **Write a full `TargetAdapter` when** you need plugin bundle
layouts, hook systems beyond the flat `hooks.json` shape, TOML tables with
nonstandard nesting, or detection logic the spec cannot express (like the
Codex/Claude/Kimi adapters).

A minimal real spec (a fictional "zetacode" with a JSON MCP file under a
custom top key and AGENTS.md instructions):

```ts
import path from "node:path";
import { buildServerValue, defineSimpleAdapter, parseNativeServer } from "@agentpack/adapter-ext";

export const zetacodeAdapter = defineSimpleAdapter({
  id: "zetacode" as never, // TargetId is a closed enum; widen targetIdSchema
  executables: ["zeta"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".zeta"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".zeta"),
  skills: {
    user: (home) => path.join(home, ".zeta", "skills"),
    project: (root) => path.join(root, ".zeta", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".zeta", "config.json"),
    project: (ctx) => path.join(ctx.projectRoot, ".zeta", "config.json"),
    format: "json",
    topKey: ["mcp"], // servers live under the "mcp" key
    serverValue: (server) => buildServerValue(server, { envRef: "plain", cwd: true }),
    parseServer: (name, raw) => parseNativeServer(name, raw, { envRef: "plain", cwd: true }),
  },
  instructions: {
    projectFile: "AGENTS.md",
    userFile: "AGENTS.md",
    directoryFile: (dir) => `${dir}/AGENTS.md`,
  },
  hooks: { support: "unsupported" },
});
```

`buildServerValue`/`parseNativeServer` cover the common `mcpServers`-style
entry shape with knobs for URL keys (`urlKey: "serverUrl"`,
`httpUrlKey: "httpUrl"` for Gemini-style HTTP/SSE splits), explicit transport
types, env-reference syntax (`plain` `${VAR}`, `env` `${env:VAR}`, `brace`
`{env:VAR}`), and `transportKey` for entries that say `transport` instead of
`type`. `format: "yaml"` handles both real YAML (hermes `config.yaml`) and
JSONC (kilo `kilo.jsonc`); `format: "toml"` merges via `mergeTomlAtTable`
(vibe `config.toml`).

Two factory rules to know:

- **Sync-only means no bundles.** A simple adapter's `planInstall` **must
  throw when `context.bundleRoot` is set** — reaching bundle planning would
  mean writing to real config paths during a build. This is safe because the
  factory's `analyze` reports `plugin` as `unsupported`, and core's
  `buildPlugins` skips targets whose analysis says the plugin is unsupported;
  the throw is a loud guard against programming errors, not a runtime path.
- **MCP `relPath` is informational.** The factory resolves the real MCP file
  from the spec in `planInstall`, because native MCP files do not always live
  under a config root (e.g. `<VS Code User>/mcp.json`, project-root
  `kilo.jsonc`).

## Registering the adapter

The core takes adapters through an `AdapterRegistry`
(`packages/core/registry.ts`); core code never switches on target ids
directly:

```ts
import { createRegistry } from "@agentpack/core";
import { codexAdapter } from "@agentpack/adapter-codex";
import { claudeAdapter } from "@agentpack/adapter-claude";
import { kimiAdapter } from "@agentpack/adapter-kimi";
import { extAdapters } from "@agentpack/adapter-ext"; // the 15 simple adapters

const registry = createRegistry([
  codexAdapter,
  claudeAdapter,
  kimiAdapter,
  ...extAdapters,
  createZedcodeAdapter(),
]);
```

The CLI builds exactly this registry at startup (built-in adapters plus any
configured third-party ones) and passes it to `loadWorkspace` consumers —
`validateWorkspace`, `buildPlan`/`syncWorkspace`, `buildPlugins`,
`importFromTarget`, and `runDoctor`. Adapter-specific CLI flags are forwarded
through `PlanOptions.adapterOptions` into `AdapterContext.options` (this is
how `--kimi-path-strategy` reaches the kimi adapter), so document any options
your adapter reads from `context.options`.

## Testing guidance

The `packages/testing` package and the adapters' own test helpers show the
established patterns:

- **Fake detection.** Build a `DetectionContext` with a stub
  `findExecutable` (`async (name) => (name === "zed" ? "/usr/bin/zed" :
undefined)`), a tmp `homeDir` and `projectRoot`, and a fixed `platform`.
  Test the absent-agent path too — `detect` must return
  `installed: false` with config roots filled in and must not throw.
- **Analyze/generate are pure.** Construct a `CanonicalPack` by hand (or load
  one from a fixture pack) and assert on the returned findings and artifact
  arrays. Snapshot or golden-file the artifact contents — they are plain data,
  which makes goldens stable.
- **Plan against tmp dirs.** Set `detection.projectConfigRoot`/`userConfigRoot`
  to directories under a tmp dir and assert the absolute paths and operation
  types, for both `installMode: "symlink"` and `"copy"`, and for
  `bundleRoot` if you support bundles.
- **End-to-end through the installer.** Run `planOperations` +
  `applyOperations` from `@agentpack/filesystem` in a tmp dir and compare the
  resulting native files against golden outputs, including merge behavior into
  pre-existing unmanaged config.
- **Import round-trips.** Write native config in a tmp dir, run `import`, and
  assert the canonical result — especially that secret strings come back as
  `fromEnv`/`template` references, never values.
