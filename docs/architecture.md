# Architecture

AgentPack is a compiler. It reads canonical YAML, validates it, lowers it to a
canonical intermediate representation (IR), analyzes per-target capabilities,
lets target adapters generate native artifacts as pure data, and hands the
resulting install operations to a single shared installer that is the only
component allowed to touch the filesystem.

## The compiler pipeline

```
canonical source          agentpack.yaml + packs/<name>/pack.yaml + skill dirs
      │
      ▼
parser / schema validation  zod schemas (packages/schema/pack.ts), skill checks
      │                     (packages/core/skill.ts), hardcoded-secret scan
      ▼
canonical IR                CanonicalPack etc. (packages/schema/ir.ts)
      │
      ▼
capability analysis         adapter.analyze(pack) → CapabilityReport per target
      │                     native · transpiled · degraded · unsupported
      ▼
adapters                    adapter.generate(pack) → GeneratedArtifact[] (data only)
      │                     adapter.planInstall(artifacts) → InstallOperationLike[]
      ▼
generated artifacts         file · skill · json-merge · toml-merge · markdown-section
      │
      ▼
safe installer / sync       planOperations → conflict check vs state.json →
      │                     backup → applyOperations → ownership recording → prune
      ▼
native configuration        .agents/skills, .codex/config.toml, AGENTS.md,
                            .claude/, .mcp.json, CLAUDE.md, .kimi-code/, …
```

Loading (`packages/core/load-workspace.ts`, `load-pack.ts`) resolves every pack
source — local `path` entries validated with `resolveInside` (no escaping the
workspace root), git sources checked out at locked commits — parses and
validates the manifests, loads skill directories, and produces
`CanonicalPack`s plus diagnostics. Validation, planning, diffing, and building
are all **side-effect free**; only `sync`, `remove`, `import`, and `rollback`
write, and only through the installer.

## Canonical IR

Adapters never read YAML. They consume normalized in-memory structures defined
in `packages/schema/ir.ts`:

- **`CanonicalPack`** — `metadata` (name, version, description, license,
  keywords), `rootDir` (absolute pack root), `skills`, `instructions`,
  `mcpServers`, `hooks`, optional `plugin`, plus two pre-computed maps:
  `targetEnabled` (per-target on/off from `spec.targets`, default `true`) and
  `targetExtensions` (raw `spec.extensions.<target>` data, passed through to
  exactly one adapter).
- **`CanonicalSkill`** — a validated Agent Skill directory: `name` (equal to
  the directory name), `description`, absolute `rootDir`, sorted POSIX
  relative `files`, and parsed `frontmatter` of `SKILL.md`.
- **`CanonicalInstruction`** — `id`, absolute `sourcePath`, markdown
  `content`, `scope` (`global` | `project` | `directory`), optional
  `directory`, `priority`, `mergeStrategy` (`managed-section` | `append`),
  optional `targets` filter.
- **`CanonicalMcpServer`** — the manifest `McpServerSpec` plus its `name`.
  Transport (`stdio` | `http` | `sse`), command/args/cwd or url/headers,
  `env`/`passEnv`, timeouts, `enabled`, `allowTools`/`denyTools`, `approval`,
  `extensions`.
- **`CanonicalHook`** — `id`, `event` (one of `preToolUse`, `postToolUse`,
  `sessionStart`, `sessionEnd`, `userPromptSubmit`, `notification`), optional
  `matcher`, `command` (argv array), optional `targets`, `extensions`.
- **`CanonicalPlugin`** — `enabled` plus optional `interface` metadata
  (displayName, descriptions, author, homepage, categories) used for plugin
  bundle manifests.

A fully loaded workspace is a `LoadedWorkspace`: absolute `rootDir`, the
parsed `WorkspaceManifest`, and the resolved `CanonicalPack[]`.

## Adapter lifecycle

A target adapter (`TargetAdapter`, `packages/schema/adapter.ts`) has four
required methods and one optional one:

1. **`detect(context) → TargetDetection`** — best-effort detection of the
   native agent: executable on `PATH` (via the injectable
   `context.findExecutable`), version probe, user/project config roots,
   warnings. **Must not throw when the agent is absent** — it reports
   `installed: false` and sync still generates config.
2. **`analyze(pack, context) → CapabilityReport`** — classify every component
   of the pack for this target: `native` (maps 1:1), `transpiled` (rendered
   into a different but equivalent native form), `degraded` (rendered with
   loss or partially dropped), `unsupported` (cannot be represented). Findings
   carry `message`/`remediation` and feed the strictness modes.
3. **`generate(pack, context) → GeneratedArtifact[]`** — produce native
   artifacts as **pure data**. Adapters never write to the filesystem here;
   artifact `root` tags (`projectConfig` | `userConfig` | `bundle`) keep them
   path-agnostic. When `context.options.bundle === true` the adapter emits a
   self-contained plugin bundle layout under the `bundle` root instead.
4. **`planInstall(artifacts, context) → InstallOperationLike[]`** — convert
   artifacts into installer operations with absolute paths, honoring
   `installMode` (`symlink` vs `copy` for skill directories), the scope's
   config roots from detection, adapter options (e.g. the kimi path strategy),
   and `bundleRoot` for builds.
5. **`import?(context) → ImportedConfiguration`** — optional, **read-only**:
   read existing native configuration (skills, MCP servers, instructions)
   back into canonical form. The core importer deduplicates skills by content
   hash and writes a new pack.

The central rule: **adapters return data; the shared installer touches the
filesystem.** Artifact kinds map one-to-one onto install operations:

| Artifact kind      | Install operation                 | Effect                                                  |
| ------------------ | --------------------------------- | ------------------------------------------------------- |
| `file`             | `writeFile`                       | Atomic full-file write.                                 |
| `skill`            | `createSymlink` / `copyDirectory` | Install a skill directory (mode-dependent).             |
| `json-merge`       | `mergeJson`                       | Merge a value at a JSON pointer, preserving other keys. |
| `toml-merge`       | `mergeToml`                       | Merge a value at a TOML table path.                     |
| `markdown-section` | `managedMarkdownSection`          | Upsert (or append) an AgentPack-managed section.        |

`removeOwnedPath` is emitted by the planner itself when previously owned paths
are no longer desired.

## The synchronization transaction

`syncWorkspace` (`packages/core/sync.ts`) runs as a single guarded
transaction:

1. **Detect** targets and **load** `.agentpack/state.json`.
2. **Plan** (`buildPlan`, side-effect free): resolve the selection
   (profile/overrides), run `analyze` + `generate` + `planInstall` per target,
   classify each operation (`create` | `update` | `noop` | `remove`) via
   `planOperations`, and compute stale removals — paths recorded as owned in
   `state.json` that are no longer desired.
3. **Trust gate** — refuse before touching anything if a selected pack has
   executable components and is not trusted (see below).
4. **Conflict check** — compare recorded ownership checksums against the live
   filesystem (see below). Conflicts abort unless `--force`.
5. **Process lock** — `.agentpack/agentpack.lock` serializes concurrent syncs.
6. **Backup** — every existing path about to be modified or removed is copied
   into `.agentpack/backups/<id>/` (reason `sync`; `remove` uses `remove`).
7. **Apply** — `applyOperations` executes the plan with atomic writes;
   recursive deletes are guarded (`guardRemove`) so only paths recorded as
   owned can be removed.
8. **Record ownership** — per target, `ownedFiles` (path, type, checksum) and
   `ownedConfigKeys` (path, JSON pointer or TOML table, checksum) are rebuilt,
   `lastSyncAt` is set, new trust grants are persisted, and `state.json` is
   written atomically.
9. **Prune** — stale owned paths are removed, and old backups are pruned to
   the 10 most recent.

Sync is idempotent: a second run plans `noop` for everything and writes
nothing.

**Watch mode** (`packages/core/watch.ts`) wraps the same transaction in a
filesystem loop: `agentpack watch` recursively watches every pack root plus
`agentpack.yaml` (ignoring `.git`, `.agentpack`, `node_modules`, `dist`, and
non-canonical file extensions), debounces events (default 400 ms, serialized —
a sync in progress queues at most one follow-up), then reloads the workspace
and runs `syncWorkspace` again. Trust grants already in `state.json` are
reused, so steady-state edits sync silently; trust refusals and conflicts are
reported as events and watching continues. It runs until its `AbortSignal`
fires (Ctrl-C in the CLI).

## The ownership model

`state.json` records, per target, exactly what AgentPack is responsible for:

- **`ownedFiles`** — whole paths AgentPack created: written files, skill
  symlinks, copied skill directories. Each entry stores a checksum (file hash,
  directory hash, or `symlink:<target>` hash).
- **`ownedConfigKeys`** — individual keys inside shared config files: a JSON
  pointer in `.mcp.json`/`settings.json`, a TOML table path in
  `config.toml`, or a managed markdown section (stored as the pseudo-pointer
  `#markdown:<sectionId>`). Checksums are computed over a deterministic
  serialization (`stableStringify`).

Ownership is **not** blanket permission to overwrite. It is the exact basis
for two decisions: what may be deleted (only owned paths, and only when their
checksum still matches), and what counts as a conflict (an owned path or key
whose live checksum differs from the recorded one). Unmanaged keys in the same
files are never touched by merges and never claimed.

### Adopted state

`TargetState` also carries an optional `adopted` record — the mirror image of
ownership. It captures **pre-AgentPack configuration that onboarding replaced**
so it can be restored byte-for-byte:

- **`adopted.configKeys`** — native MCP entries that duplicated canonical
  servers (matched case-insensitively), removed from the native file by
  `agentpack gateway setup --adopt`. Each entry stores the JSON pointer or
  TOML table path, the **exact original value inline**, and its checksum.
- **`adopted.paths`** — unmanaged files or directories that stood where
  `agentpack sync --adopt` needed to create (e.g. a copied skill directory
  where a symlink belongs). Each entry stores the path, its type, and the id
  of the backup the original was moved into **before** replacement.

Adoption is always recorded before mutation and never repeated for entries
already recorded; path adoption is skipped entirely when the existing content
already matches the desired content.

### The uninstall transaction

`agentpack uninstall` (`packages/core/uninstall.ts`) reverses the whole
onboarding, per selected target:

1. **Remove owned items** pack by pack — the same checksum-guarded removal
   logic as `agentpack remove`, over every pack.
2. **Remove the gateway entry** (`uninstallGateway`).
3. **Restore adopted config keys** — each recorded value is merged back into
   its native file at its original pointer/table. In the normal flow the key
   is absent at this point (adoption removed it and gateway mode never
   reinstalls individual servers); keys that cannot be restored are reported
   as skipped.
4. **Restore adopted paths** — the original is copied back from its recorded
   backup, but only when the path is currently absent; an existing path that
   is not AgentPack-owned is left in place and reported.

Restored entries are dropped from `adopted`; state is saved atomically at the
end. Unmanaged configuration is never touched anywhere in the transaction, and
`--dry-run` reports the full remove/restore plan without writing.

## Native change collection

Collection is the inward counterpart of import (`packages/core/collect.ts`):
it detects MCP servers and skills installed **directly into an agent** and
gathers them into the workspace for review.

Pipeline per target:

1. **Import** — the target adapter's read-only importer reads the user-scope
   native config (skills, MCP servers).
2. **Delta against the known set** — a server is skipped when its name
   (lowercased) is already canonical in any workspace pack, was previously
   adopted from this target, or is the gateway entry; a skill is skipped when
   its content hash matches any skill in any pack (or an existing inbox skill
   path). Server names are normalized to lowercase-hyphen pack keys
   (`XcodeBuildMCP` → `xcodebuildmcp`, numeric suffix on collision).
   Instructions are never collected.
3. **Secret curation** — literal env/header values matching the secret
   patterns are preserved verbatim with a warning by default, or converted to
   `{ fromEnv: NAME }` with `--env-refs` (values are never printed either
   way).
4. **Merge into the inbox pack** — new skills are written under
   `packs/inbox-<target>/skills/` and new servers merged into the existing
   (or freshly created) inbox `pack.yaml`, atomically. The workspace manifest
   gains a `- path: ./packs/inbox-<target>` reference — but the pack is
   **never added to any profile**, so `resolveSelection` never picks it up
   and nothing fans out.

**Where inbox packs sit in the ownership model:** they are ordinary canonical
packs on disk, but outside every profile — the sync engine never plans
operations for them, so they produce no `ownedFiles`/`ownedConfigKeys` entries
and no trust requirements until promoted. Collection itself writes only inside
the workspace (inbox pack + the `agentpack.yaml` reference); native agent
config is only read.

**Promotion** (`packages/core/promote.ts`) is the explicit boundary crossing:
`agentpack promote <pack>` appends the pack to the `default` profile in
`agentpack.yaml`, records a content-hash trust grant in `state.json` (the same
hash the trust gate computes, so the subsequent sync passes), reloads the
workspace, and runs a normal sync.

**Automation drivers** feed the same collect function:

- `agentpack watch --collect` additionally watches each target's native
  sources (`adapter.nativeSources`, user scope) with a 2 s debounce and emits
  `collected` events; collect's own writes (inbox packs, the `agentpack.yaml`
  edit) are suppressed so they cannot trigger sync cycles.
- `agentpack service install` registers that watch command as a per-user
  login service — launchd (`~/Library/LaunchAgents/dev.agentpack.watch.plist`)
  on macOS, a systemd `--user` unit on Linux — logging to
  `.agentpack/service.log`. Loading is best-effort: if `launchctl bootstrap`
  fails, the file still auto-loads at next login and the warning carries the
  exact manual command.
- `agentpack hooks install` appends an AgentPack-owned SessionStart entry to
  `~/.claude/settings.json` (marker: the command contains `collect --from`)
  running `agentpack collect --from claude --quiet`. With `--quiet`, collect
  prints a single line only when something was collected — that line lands in
  the agent's session context, so the agent can relay it ("say 'promote' to
  share"). Install is idempotent and backs up `settings.json` first;
  uninstall removes only marked entries and prunes the array when empty.
  Other targets report "no hook system".

## Conflict handling

Before applying, sync re-checksums every owned path and owned key and compares
against `state.json`:

- Missing or unchanged → fine.
- Changed externally, but already equal to the desired new content → fine
  (converged by other means).
- Changed externally → **conflict**: `file was modified externally since the
last sync` (or the config-key equivalent). Removals of externally modified
  owned paths are likewise refused.

Any conflict aborts the sync with exit code **3** unless `--force` is given.
With `--force` the external changes are overwritten — but the backup taken in
step 6 preserves them, and `agentpack rollback` restores them. `agentpack
remove` applies the same rule in reverse: it refuses to delete or unmerge
anything whose checksum no longer matches.

## The trust model

A pack can request execution power: stdio MCP commands, remote MCP endpoints,
hooks, and executable script files inside skills. `packages/core/trust.ts`
computes a `TrustRequirement` per pack:

- counts of local (stdio) MCP commands, remote MCP endpoints, hooks, and
  script files (`scripts/` paths or `*.mjs/cjs/js/sh/py/rb/ts` anywhere in a
  skill);
- a **content hash** over everything executable: each MCP server's transport,
  command, args, and URL; each hook's id, event, and command; and each skill's
  `scripts/` file list.

A pack with no executable components needs no trust. Otherwise sync refuses
(exit **4**) with a human-readable trust summary unless the pack was granted
trust for the **same content hash** in a previous run (recorded in
`state.json` under `trust`) or is named via `--trust <pack>`. Because trust is
content-hash-bound, changing an MCP command, a hook, or the script set
invalidates the grant and the next sync refuses again — trust cannot be
carried over a silent change. Grants given via `--trust` are persisted after a
successful sync; `agentpack remove` deletes the pack's recorded grant.

## The MCP gateway layer

Gateway mode replaces "merge every MCP server into every target" with a live
aggregation proxy (`packages/gateway`, zero runtime dependencies). Each agent
launches **one** MCP server — the gateway — which fans out to all canonical
servers:

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│  codex  │  │ claude  │  │  kimi   │      each agent config holds a single
└────┬────┘  └────┬────┘  └────┬────┘      "agentpack" stdio MCP entry
     └────────────┼────────────┘
                  ▼  NDJSON over stdio (one JSON-RPC message per line)
        ┌───────────────────────┐
        │   agentpack gateway   │  tools/list aggregated + namespaced
        │  (@agentpack/gateway) │  tools/call routed by <server>__<tool>
        └───────┬───────┬───────┘
                │       │       per-server degradation: a failed server
        ┌───────┘       │       contributes zero tools, the rest keep serving
        ▼               ▼
   stdio children   Streamable-HTTP POSTs      downstream MCP servers
   (spawned with    (JSON or SSE bodies,       (from gateway.json)
    minimal env)     request/response)
```

**Config flow.** `agentpack gateway setup` (`packages/core/gateway.ts`):

1. Builds `<workspace>/gateway.json` from the selected packs: deduplicated
   server definitions (`{ version: 1, launcher, servers }`) with env values
   rendered as `${VAR}` references — never resolved — plus a **launcher**
   record (`node <cli-path> gateway run --config <path>`) describing how
   agents should start the gateway.
2. Generates the entry per target through the normal adapter pipeline by
   feeding each adapter a **synthetic single-server pack** (one stdio server
   named after `gateway.name`, default `agentpack`, whose command is the
   launcher), so the gateway entry lands exactly where that target keeps MCP
   config (`.codex/config.toml` `[mcp_servers.agentpack]`, `.mcp.json`,
   `mcp.json`).
3. **Reclaims** the individual MCP config keys a previous sync installed —
   only keys recorded in `state.json` as owned whose checksum still matches
   (`--force` overrides) — backs up every touched file (backup reason
   `gateway`), and records ownership of the new gateway key.

`agentpack gateway uninstall` removes only the gateway key per target; a
normal `agentpack sync` then restores the individual servers.

**Interaction with sync.** While `agentpack.yaml` sets `gateway.enabled:
true`, `buildPlan` filters out individual MCP artifacts (`isMcpArtifact`:
json-merges under `/mcpServers/`, toml-merges under `mcp_servers`) and injects
the gateway entry instead, using the launcher recorded in `gateway.json`. If
`gateway.json` is missing the plan carries a warning
(`run agentpack gateway setup`). Skills, instructions, and hooks are
unaffected, and sync stays idempotent — the gateway entry is just another
owned, checksummed config key.

**Runtime behavior** (`agentpack gateway run --config <path>`):

- **Upstream**: NDJSON framing on stdin/stdout — one JSON-RPC message per
  line; logs go to stderr only. Handles `initialize`, `ping`, `tools/list`,
  `tools/call`.
- **Downstreams**: stdio servers are spawned (NDJSON pipes,
  `initialize` → `notifications/initialized` → `tools/list` handshake);
  `http`/`sse` servers use Streamable-HTTP POSTs with `mcp-session-id`
  tracking, accepting JSON or `text/event-stream` response bodies.
- **Namespacing and filtering**: every downstream tool is exposed as
  `<server>__<tool>`; `allowTools`/`denyTools` are applied at aggregation
  time, so they work uniformly on every target.
- **Degradation**: all downstreams start in parallel; a server that fails its
  handshake (e.g. a missing `${VAR}` in the gateway's environment) is marked
  degraded and contributes zero tools while the rest keep serving; calls to a
  degraded server return a JSON-RPC error.
- **Env resolution**: `${VAR}` placeholders are resolved from the gateway's
  own process environment at startup, in memory only — values are never
  written to disk. Downstream stdio children receive a minimal environment
  (`PATH`, `HOME`, `passEnv` names, resolved `env` entries only).
- **Redaction**: downstream stderr lines and error messages pass through
  secret redaction before being logged or returned to the agent.

Because the gateway is the process that actually executes downstream MCP
servers on the agent's behalf, pack trust still applies: the trust content
hash covers MCP command/args/URL definitions, so changing a server invalidates
the grant exactly as in non-gateway mode.

## Secret handling

Canonical `env` and `headers` values use one of three forms
(`packages/schema/secrets.ts`):

- `{ value: "…" }` — literal, non-secret;
- `{ fromEnv: "VAR" }` — resolved by the **native agent** at runtime;
- `{ template: "…${VAR}…", requiredEnv: ["VAR"] }` — literal text with
  `${VAR}` placeholders, also resolved by the native agent.

AgentPack **never resolves** these. Generation renders them into the target's
native reference syntax (`renderEnvRecord`, default `${VAR}`) and writes the
reference, not the value. Validation and `doctor` report referenced variables
**by name only** (`environment variable not set: GITHUB_TOKEN … — name only,
value never read`). Loading scans the raw `pack.yaml` for hardcoded secrets
(API keys, tokens, private-key blocks, generic `key = value` assignments) and
emits warnings containing the pattern name and line number — never the matched
value — and `redactSecrets` applies the same patterns to arbitrary output.
Secrets never appear in plans, diffs, state, backups, or generated files;
imports parse native `${VAR}` strings back into `fromEnv`/`template` forms so
imported manifests contain references, not secrets.
