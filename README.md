# AgentPack

**Author once, validate once, synchronize everywhere** — AgentPack keeps your
AI-agent extensions in one canonical repo and compiles them into native config
for **OpenAI Codex**, **Anthropic Claude Code**, and **Kimi Code**.

[![CI](https://github.com/Hardt-LLC/AgentPack/actions/workflows/ci.yml/badge.svg)](https://github.com/Hardt-LLC/AgentPack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Agent Skills, MCP server definitions, persistent instructions, hooks, and
plugin metadata live as YAML + Markdown in one repository; the `agentpack` CLI
validates them, analyzes what each agent supports, and safely installs the
result into each agent's native configuration.

## Why AgentPack

- **One canonical repo, no drift.** The same skill, MCP server, or instruction
  is authored once and compiled per agent, instead of being copy-pasted
  between `.codex/`, `.claude/`, and `.kimi-code/` until the copies diverge.
- **Safe sync.** Every change is planned before it is applied: backups are
  taken first, externally modified files are detected as conflicts (never
  silently overwritten), and `state.json` ownership checksums track exactly
  what AgentPack is responsible for — and nothing else.
- **An MCP gateway layer.** Optionally, each agent gets a single MCP entry
  pointing at the AgentPack gateway, which fans out live to all canonical
  servers — one entry to manage instead of N entries per agent.
- **Reversible onboarding.** AgentPack layers onto existing agent setups
  without destroying them: pre-existing config is _adopted_ (recorded
  restorably), and `agentpack uninstall` puts the original configuration back.

## Features at a glance

| Area                   | What you get                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Components             | Agent Skills, MCP servers (stdio/http/sse), instructions, hooks, plugin metadata — one `pack.yaml` per pack.                                                   |
| Targets                | OpenAI Codex, Anthropic Claude Code, Kimi Code; third-party targets via the adapter API.                                                                       |
| Capability negotiation | Per-component findings (`native` / `transpiled` / `degraded` / `unsupported`) with `permissive`, `strict`, and `portable` strictness modes.                    |
| Sync engine            | Side-effect-free plans, atomic writes, backups, conflict detection (exit 3), trust gate for executable packs (exit 4), idempotent re-syncs.                    |
| MCP gateway            | One entry per agent; live fan-out; tools namespaced `<server>__<tool>`; per-server degradation; `allowTools`/`denyTools` enforced uniformly.                   |
| Watch mode             | `agentpack watch` re-syncs on every pack edit, debounced; trust refusals and conflicts are reported while watching continues.                                  |
| Distribution           | Git-sourced packs pinned by commit in a lockfile; `agentpack build` produces redistributable per-target plugin bundles.                                        |
| Onboarding             | `gateway setup --adopt` / `sync --adopt` take over pre-existing config restorably; `agentpack uninstall` removes AgentPack and restores the originals.         |
| Auto-collection        | `agentpack collect` gathers natively installed MCP servers/skills into reviewable `packs/inbox-<target>/` packs; `agentpack promote` shares them after review. |
| Background operation   | `agentpack service install` runs `watch --collect` at login (launchd / systemd user); a Claude SessionStart hook collects at every session start.              |
| Secrets                | `{ fromEnv }` / template env references only — never resolved, never written to disk; hardcoded-secret scanning; names-only reporting.                         |

## Installation

Prerequisites: **Node.js 20+** and **pnpm 9** (via Corepack, bundled with
Node).

```bash
git clone https://github.com/Hardt-LLC/AgentPack.git
cd AgentPack
corepack enable
pnpm install
pnpm build
cd apps/cli && pnpm link --global   # or add apps/cli/dist to your PATH
agentpack --help
```

The CLI binary is `apps/cli/dist/cli.mjs` (the `agentpack` bin).
AgentPack is not yet published to the npm registry — building from source, as
above, is currently the only install path.

## Quickstart (5 minutes)

The fastest path is the interactive wizard — it detects your agents, imports
existing config, lets you curate what to keep, syncs, and installs background
automation in one go:

```bash
agentpack setup        # interactive; --yes accepts all defaults (CI/scripts)
```

Prefer to drive each step yourself? Read on.

```bash
# 1. Create a workspace anywhere (your extensions repo)
mkdir my-extensions && cd my-extensions
agentpack init

# 2. Author a pack: packs/<name>/pack.yaml plus skills/, instructions/,
#    hooks/ — or copy examples/basic or examples/security-review from the
#    AgentPack repo as a starting point.

# 3. Validate: schemas, skills, cross-pack duplicates, env references,
#    per-target capabilities
agentpack validate

# 4. Preview the exact filesystem operations per target (side-effect free)
agentpack plan

# 5. Sync into native config. Packs with executable components
#    (hooks, stdio MCP servers, scripts) require explicit trust:
agentpack sync --trust security-review

# 6. Optionally build redistributable plugin bundles into dist/
agentpack build
```

After the sync, each agent finds its native files in place, for example:

- **Codex**: skills symlinked into `.agents/skills/`, MCP servers merged into
  `.codex/config.toml`, instructions as managed sections in `AGENTS.md`.
- **Claude Code**: skills in `.claude/skills/`, MCP servers in `.mcp.json`,
  instructions in `CLAUDE.md`, hooks in `.claude/settings.json`.
- **Kimi Code**: skills in `.agents/skills/` (or `.kimi-code/skills/`), MCP
  servers and hooks in `.kimi-code/mcp.json` / `hooks.json`, instructions in
  `AGENTS.md`.

Re-running `agentpack sync` immediately afterwards is a no-op — `agentpack
diff` reports clean.

Everything AgentPack writes is a **build artifact**. Generated files
(`.codex/config.toml` entries, `.mcp.json`, `CLAUDE.md` managed sections,
installed skill directories, …) must not be hand-edited — the next sync will
either overwrite the edit or refuse with a conflict. Edit the canonical packs
and re-sync instead.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ canonical sources                                                  │
│   agentpack.yaml (workspace)   packs/<name>/pack.yaml (packs)      │
│   skills/ instructions/ hooks/ mcpServers/ extensions              │
└───────────────┬────────────────────────────────────────────────────┘
                │ parse + zod validation + skill checks + secret scan
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ canonical IR (packages/schema/ir.ts)                               │
│   CanonicalPack { skills, instructions, mcpServers, hooks,         │
│                   plugin, targetEnabled, targetExtensions }        │
└───────────────┬────────────────────────────────────────────────────┘
                │ per-target capability analysis
                │   native · transpiled · degraded · unsupported
                ▼
┌──────────────────┬──────────────────────┬──────────────────────────┐
│ codex adapter    │ claude adapter       │ kimi adapter             │
│ generate() →     │ generate() →         │ generate() →             │
│ artifacts (pure  │ artifacts (pure      │ artifacts (pure          │
│ data, no I/O)    │ data, no I/O)        │ data, no I/O)            │
└────────┬─────────┴──────────┬───────────┴────────────┬─────────────┘
         │ planInstall() → InstallOperations (absolute paths)
         ▼
┌────────────────────────────────────────────────────────────────────┐
│ safe installer (packages/core + packages/filesystem)               │
│   process lock → conflict check vs state.json checksums → backup   │
│   → applyOperations (atomic writes, merges, managed sections)      │
│   → record ownership + checksums → prune stale owned paths         │
└───────────────┬────────────────────────────────────────────────────┘
                ▼
 native config: .agents/skills  .codex/config.toml  AGENTS.md
                .claude/skills  .mcp.json  CLAUDE.md  .claude/settings.json
                .kimi-code/mcp.json  .kimi-code/hooks.json  …
```

Adapters only ever return **data**; the shared installer is the single
component that touches the filesystem. See
[docs/architecture.md](docs/architecture.md) for the full pipeline.

## Canonical directory layout

```
my-extensions-repo/
├── agentpack.yaml              # workspace manifest: pack sources + profiles
├── gateway.json                # gateway config (written by `agentpack gateway setup`)
├── packs/
│   └── security-review/
│       ├── pack.yaml           # canonical pack manifest
│       ├── skills/
│       │   └── security-review/
│       │       ├── SKILL.md    # frontmatter: name, description
│       │       ├── scripts/
│       │       └── references/
│       ├── instructions/
│       │   └── common.md
│       ├── hooks/
│       │   └── check-shell.mjs
│       └── assets/             # optional, copied into plugin bundles
└── .agentpack/                 # AgentPack bookkeeping (see below)
    ├── lock.json               # pinned commits for git pack sources — commit this
    ├── state.json              # ownership + checksums + trust grants
    ├── agentpack.lock          # process lock while a sync runs
    ├── cache/git/              # cached clones of git pack sources
    ├── backups/                # pre-sync backups (10 most recent kept)
    └── generated/              # scratch space for generated intermediates
```

Commit `agentpack.yaml`, `packs/`, and `.agentpack/lock.json`. Everything else
under `.agentpack/` is machine-local state (paths inside `state.json` are
absolute); keep it out of version control.

## Command reference

Global flag for every command:

- `--workspace <dir>` — workspace root; defaults to walking upward from the
  current directory looking for `agentpack.yaml`.

Selection flags shared by `validate`, `plan`, `sync`, `diff`, `build`:

- `--profile <name>` — use a profile from `agentpack.yaml` (default: the
  `default` profile, or all packs × all targets when no profiles exist).
- `--targets codex,claude,kimi` — restrict targets (also `--target <id>`).
- `--scope project|user` — install into the project or the user config root.
- `--mode auto|symlink|copy` — skill install mode (`auto` = symlink, falling
  back to copy on Windows / filesystems without symlink support).
- `--strictness permissive|strict|portable` — how capability findings
  (`degraded`/`unsupported`) are treated. `permissive` warns; `strict` and
  `portable` turn them into errors.
- `--json` — machine-readable output.

Commands:

| Command                                 | What it does                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentpack init`                        | Scaffold `agentpack.yaml` and a starter `packs/` layout.                                                                                                                                                                                                                                                                                                                    |
| `agentpack setup`                       | Interactive onboarding wizard: workspace creation, agent detection, import, curation, secrets policy, profile, trust, sync, gateway, background service, and session hook — in one guided pass. `--yes` accepts all defaults (required on non-TTY).                                                                                                                         |
| `agentpack validate`                    | Full workspace validation: schemas, skills, duplicates, MCP env references, capability analysis. Fails (exit 1) on any error.                                                                                                                                                                                                                                               |
| `agentpack plan`                        | Print the side-effect-free execution plan per target: operations, capability findings, install strategy.                                                                                                                                                                                                                                                                    |
| `agentpack sync`                        | Apply the plan: trust gate → conflict check → backup → apply → record ownership. Flags: `--dry-run`, `--force`, `--trust <pack>` (repeatable), `--adopt` (adopt unmanaged paths blocking planned creates), `--kimi-path-strategy shared\|kimi`.                                                                                                                             |
| `agentpack build`                       | Generate redistributable plugin bundles to `dist/<target>/<pack>/` (pure build step, separate from sync). Flags: `--output <dir>`, `--dry-run`.                                                                                                                                                                                                                             |
| `agentpack diff`                        | Show the difference between desired canonical state and installed state. Exit 0 = clean, exit 1 = differences.                                                                                                                                                                                                                                                              |
| `agentpack doctor`                      | Health checks: Node version, symlinks, target detection, config-root writability, required env vars (names only), state consistency, broken symlinks, native config parse errors.                                                                                                                                                                                           |
| `agentpack list`                        | List packs, profiles, and detected targets.                                                                                                                                                                                                                                                                                                                                 |
| `agentpack import --from <target>`      | Import existing native config (skills, MCP servers, instructions) into a new canonical pack under `packs/`. Read-only for the source; `--dry-run` supported.                                                                                                                                                                                                                |
| `agentpack remove <pack>`               | Remove everything the pack owns on the selected targets — and nothing else. Refuses to remove externally modified files. Flags: `--target`, `--scope`, `--dry-run`.                                                                                                                                                                                                         |
| `agentpack rollback`                    | Restore the most recent backup (or `--to <backup-id>`). Backups are listed newest-first.                                                                                                                                                                                                                                                                                    |
| `agentpack update`                      | Re-resolve git pack sources to the newest commit of their configured `ref` and rewrite `.agentpack/lock.json`.                                                                                                                                                                                                                                                              |
| `agentpack watch`                       | Watch all pack directories (recursive; ignores `.git`/`.agentpack`/`node_modules`/`dist`) and re-sync on change, debounced (`--debounce <ms>`, default 400). Trust refusals and conflicts are reported and watching continues. Flags: `--profile`, `--target`/`--targets`, `--scope`, `--mode`, `--strictness`, `--collect` (also collect native changes into inbox packs). |
| `agentpack collect`                     | Collect natively installed MCP servers and skills (plugin menus, manual installs) into reviewable `packs/inbox-<target>/` packs. User scope. Flags: `--from <target>`, `--dry-run`, `--env-refs` (convert literal secrets to env references), `--quiet` (one line, only on change).                                                                                         |
| `agentpack promote <pack>`              | Review→share in one step: add the pack to the `default` profile, record a content-hash trust grant, and sync. Flag: `--dry-run`.                                                                                                                                                                                                                                            |
| `agentpack service install`             | Install and load the per-user `watch --collect` background service (launchd on macOS, systemd user service on Linux; no sudo). Logs to `.agentpack/service.log`.                                                                                                                                                                                                            |
| `agentpack service status`              | Show whether the watch service is installed and running.                                                                                                                                                                                                                                                                                                                    |
| `agentpack service uninstall`           | Unload and remove the watch service.                                                                                                                                                                                                                                                                                                                                        |
| `agentpack hooks install`               | Install the AgentPack-owned SessionStart collect hook (`agentpack collect --from claude --quiet`) into `~/.claude/settings.json`. Idempotent; backs up first; user hooks untouched. Flag: `--target claude` (default).                                                                                                                                                      |
| `agentpack hooks uninstall`             | Remove only AgentPack's collect-hook entries from the Claude settings.                                                                                                                                                                                                                                                                                                      |
| `agentpack gateway run --config <path>` | Run the MCP aggregation gateway on stdio. This is the process agents launch — you normally never run it by hand.                                                                                                                                                                                                                                                            |
| `agentpack gateway setup`               | Write `<workspace>/gateway.json` (server definitions + launcher record), install ONE gateway MCP entry per target, and reclaim previously synced individual MCP keys AgentPack owns. Backs up first. Flags: `--targets`, `--scope`, `--force`, `--adopt` (adopt duplicate unmanaged MCP entries).                                                                           |
| `agentpack gateway uninstall`           | Remove the gateway MCP entry from each target. A following `agentpack sync` restores the individual servers. Flags: `--targets`, `--scope`.                                                                                                                                                                                                                                 |
| `agentpack uninstall`                   | Fully uninstall from the selected targets: remove everything AgentPack owns (files, config keys, the gateway entry), then restore every adopted (pre-AgentPack) config key and path. Flags: `--targets`, `--scope`, `--dry-run`.                                                                                                                                            |

Exit codes:

| Code | Meaning                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success (for `diff`: no differences).                                                                                       |
| 1    | Validation failure; for `diff`: differences found.                                                                          |
| 2    | Operational error (I/O, corrupt state, missing pack, …).                                                                    |
| 3    | Conflict: files/keys AgentPack owns were modified externally. Re-run with `--force` to overwrite (a backup is still taken). |
| 4    | Trust refusal: a pack with executable components is not trusted. Re-run with `--trust <pack>`.                              |

## Target examples

All examples sync the `security-review` pack from
[`examples/security-review`](examples/security-review) at **project scope**.

### Codex

```
.agents/skills/security-review -> <repo>/packs/security-review/skills/security-review   (symlink in auto mode)
.codex/config.toml       ← [mcp_servers.github] and [mcp_servers.local-security-tools] merged in
AGENTS.md                ← managed section "security-baseline" upserted
```

Notes:

- Skills are installed under `.agents/skills` (project) or `~/.agents/skills`
  (user scope), not inside `.codex/`.
- `stdio` MCP servers are native; `http` servers are transpiled into
  `config.toml` (`url` + `http_headers`); `sse` is degraded (deprecated by
  Codex).
- `allowTools`/`denyTools` have no Codex equivalent and are dropped (reported
  as degraded). `passEnv` maps to `env_vars`, `approval.default` to
  `approval_policy`.
- Hooks are **unsupported** on Codex — they are reported as such and only
  exported into the plugin bundle.

### Claude Code

```
.claude/skills/security-review -> <repo>/packs/…/skills/security-review   (symlink in auto mode)
.mcp.json                ← mcpServers entries merged (project root, next to .claude/)
CLAUDE.md                ← managed section "security-baseline" upserted
.claude/settings.json    ← hooks.PreToolUse entry for "block-dangerous-shell"
```

Notes:

- MCP `env`/`headers` are rendered as `"${VAR}"` references and resolved by
  Claude Code at runtime. `passEnv`, `approval`, and `allowTools`/`denyTools`
  have no `.mcp.json` representation and are dropped (reported as degraded).
- Hook matchers are normalized to Claude tool names: `shell` → `Bash`,
  `file` → `Read|Write|Edit`, `web` → `WebFetch|WebSearch`, `all` → omitted.
- Claude subagents can be shipped via the `spec.extensions.claude.agents`
  extension point and are emitted into the plugin bundle.

### Kimi Code

With the default **shared** path strategy:

```
.agents/skills/security-review -> <repo>/packs/…/skills/security-review   (shared with other agents)
.kimi-code/mcp.json      ← mcpServers entries merged
.kimi-code/hooks.json    ← hooks grouped by event
AGENTS.md                ← managed section "security-baseline" upserted
```

With `--kimi-path-strategy kimi`:

```
.kimi-code/skills/security-review
.kimi-code/mcp.json
.kimi-code/hooks.json
.kimi-code/AGENTS.md     ← project instructions move under .kimi-code too
```

Notes:

- Kimi's `mcp.json` supports `passEnv`, `approval`, `allowTools`/`denyTools`
  natively — they are rendered as-is.
- The `notification` hook event is unsupported by `hooks.json` and is dropped
  (reported as unsupported); all other events are transpiled.
- Global-scope instructions always land in `$KIMI_CODE_HOME` (default
  `~/.kimi-code`), regardless of the path strategy.

## MCP gateway mode

By default, sync merges every canonical MCP server into every target's native
config — N servers × M targets entries to keep consistent. Gateway mode
replaces this with a single entry per target: agents launch the **AgentPack
gateway**, a zero-dependency MCP aggregation proxy (`@agentpack/gateway`)
that fans out to the canonical servers at runtime.

Enable it in `agentpack.yaml`:

```yaml
gateway:
  enabled: true
  name: agentpack # optional; this is the default
```

Then run setup once (and again whenever you want to re-generate):

```bash
agentpack gateway setup
```

This writes `<workspace>/gateway.json` — the deduplicated server definitions
plus a launcher record (`node <cli-path> gateway run --config <path>`) — and
installs **one** MCP entry per target pointing at the gateway, e.g. in
`.mcp.json` / `mcp.json`:

```json
{
  "mcpServers": {
    "agentpack": {
      "type": "stdio",
      "command": "node",
      "args": ["…/apps/cli/dist/cli.mjs", "gateway", "run", "--config", "…/gateway.json"]
    }
  }
}
```

Setup also **reclaims** the individual per-server MCP keys that a previous
sync installed (only keys AgentPack owns, verified by checksum; `--force`
reclaims externally modified ones) and backs up every file it touches. While
`gateway.enabled` is true, `plan`/`sync` skip individual MCP server artifacts
and inject the single gateway entry instead, so sync stays idempotent.
`agentpack gateway uninstall` removes the gateway entry; a normal
`agentpack sync` then restores the individual servers.

Runtime behavior to be aware of:

- **Tool namespacing.** Agents see tools as `<server>__<tool>` (e.g.
  `github__create_issue`). `allowTools`/`denyTools` are enforced by the
  gateway at aggregation time, so they work uniformly across all targets —
  including Codex and Claude, whose native config cannot express them.
- **Per-server degradation.** A server that fails to start — for example
  because a referenced environment variable is not set in the gateway's
  environment — is skipped and logged to stderr; the gateway keeps serving
  every other server. Tool calls to a degraded server return a JSON-RPC error.
- **Env resolution.** `${VAR}` references from the canonical manifests are
  resolved inside the gateway process at runtime and are never written to
  disk. The gateway is what your agents execute, so pack trust still applies.

## Watch mode

`agentpack watch` keeps native config continuously in sync while you edit:

```bash
agentpack watch --profile default --debounce 400
```

It watches every pack directory (plus `agentpack.yaml`) recursively — ignoring
`.git`, `.agentpack`, `node_modules`, and `dist` — debounces change bursts
(default 400 ms), then reloads the workspace and re-syncs. Trust decisions
already recorded in `state.json` are reused; a trust refusal (executable
components changed) or a conflict is reported and **watching continues** — fix
the cause (re-trust, revert, or `--force` a manual sync) and the next change
syncs cleanly. Stop with Ctrl-C.

To run it permanently, supervise it like any long-running process, e.g. a
launchd agent on macOS or a systemd user unit:

```ini
# ~/.config/systemd/user/agentpack-watch.service
[Service]
ExecStart=/usr/local/bin/agentpack watch --workspace /path/to/extensions-repo
Restart=on-failure

[Install]
WantedBy=default.target
```

## Automatic collection

Sync flows **outward** (canonical repo → agents). Collection flows **inward**:
when you install MCP servers or skills directly into an agent — through a
plugin menu or by hand — `agentpack collect` detects them via the target's
importer and gathers the delta into a reviewable pack at
`packs/inbox-<target>/` (also referenced from `agentpack.yaml`, but **never
added to a profile**, so nothing fans out automatically).

Delta rules: servers already canonical, adopted, or the gateway entry are
skipped; skills are deduplicated by content hash; server names are normalized
to lowercase-hyphen pack keys; instructions are never collected. Literal
secret-looking values are **preserved** by default (they came from your own
local files) with a warning — pass `--env-refs` to store them as
`{ fromEnv: … }` references instead.

The zero-input loop, once enabled:

```bash
agentpack service install   # runs `agentpack watch --collect` at login
agentpack hooks install     # claude SessionStart hook: collect at every session start
```

From then on: install something in an agent → it lands in
`packs/inbox-<target>/` within seconds (the watch service debounces native
changes at 2s; the Claude hook reports one line into the agent's session
context — "N new items collected — say 'promote' to share") → review the
inbox pack and run:

```bash
agentpack promote inbox-claude
```

`promote` adds the pack to the `default` profile, records a content-hash trust
grant, and syncs — one command from "collected" to "shared everywhere". The
boundary is deliberate: **fan-out always stays behind review and trust** —
collection only ever writes into the workspace's inbox packs, never into
agent config.

If `launchctl bootstrap` is blocked by your terminal's permissions on macOS,
the service file is still written (and auto-loads at next login); the reported
warning includes the exact manual command to load it now.

## Onboarding without losing your existing config

AgentPack can be layered onto agents that already have hand-maintained
configuration — without destroying it. The mechanism is **adoption**: when
onboarding needs to take over something AgentPack does not own, the original
is recorded restorably first, and only then replaced.

Two kinds of adoption exist:

- **Config keys.** `agentpack gateway setup --adopt` finds native MCP entries
  that duplicate a canonical server — matched **case-insensitively**, so
  Claude's `XcodeBuildMCP` matches canonical `xcodebuildmcp` — removes them
  from the native file, and records their exact values (with checksums) inline
  in `.agentpack/state.json` under `adopted.configKeys`. Without `--adopt`,
  such duplicates are reported as warnings and left in place — the gateway
  simply runs alongside them.
- **Whole paths.** `agentpack sync --adopt` handles unmanaged files or
  directories standing where a planned create must go (typically a copied
  skill directory where a symlink belongs): the original is moved into a
  backup under `.agentpack/backups/` and recorded under `adopted.paths`, then
  AgentPack takes its place. If the existing content is already identical to
  the desired content, nothing is adopted. Entries already recorded are never
  re-adopted.

The guarantee: **nothing is deleted without a restorable record.** Backups are
always taken _before_ modification, never after; adopted values sit in
`state.json`; adopted paths sit in timestamped backups.

To leave, run:

```bash
agentpack uninstall --dry-run   # preview: what would be removed and restored
agentpack uninstall             # do it
```

Uninstall removes everything AgentPack owns — owned files, owned config keys,
and the gateway entry — then puts the pre-AgentPack state back: adopted keys
are merged back into their native files with their exact original values, and
adopted paths are copied back from the backups that captured them. An adopted
path that now exists and is not AgentPack-owned is left in place and reported.
Unmanaged configuration is never touched, so the end state is the config you
had before AgentPack, plus anything you added yourself in the meantime.

## Team Git workflow

Pack sources can be git repositories, pinned for reproducibility:

```yaml
# agentpack.yaml
packs:
  - path: ./packs/local-pack
  - source:
      type: git
      url: https://github.com/acme/agent-extensions.git
      ref: v1.4.0 # any ref: tag, branch, or commit
      subdirectory: packs/security-review # optional
```

- On first load, AgentPack clones into `.agentpack/cache/git/`, resolves the
  `ref` to an immutable commit, and records it in `.agentpack/lock.json`.
  Subsequent runs check out the locked commit.
- **Commit `.agentpack/lock.json`.** Teammates and CI then sync bit-identical
  pack content.
- `agentpack update` re-resolves refs to their newest commits and rewrites
  `lock.json` — review the diff like any dependency upgrade.
- Git operations never run repository hooks (`core.hooksPath=/dev/null`) and
  never run install scripts.

A typical team flow: one engineer updates packs → `agentpack validate` →
`agentpack update` (if git sources moved) → commit `packs/` + `lock.json` →
teammates pull and run `agentpack sync` (with `--trust` after reviewing the
trust summary when executable components changed).

## ⚠️ Security warning

**AgentPack never executes anything a pack contains** — not skill scripts, not
hook commands, not MCP stdio commands, not package lifecycle scripts, not git
hooks. It is a compiler and installer, not a runtime.

**But syncing writes configuration that native agents WILL execute.** A hook
entry in `.claude/settings.json` runs on every matching tool call; a stdio MCP
server in `.codex/config.toml` is launched by the agent; a malicious skill is
read and followed by the model. Installing a pack is granting its author
execution power inside your agent sessions.

Therefore:

- **Review packs before syncing**, exactly like you review dependencies.
- Use `--trust <pack>` deliberately, after reading the printed trust summary
  (local MCP commands, executable scripts, hooks, remote MCP endpoints).
- Trust decisions are **content-hash-bound**: when any executable component of
  a pack changes (MCP command/args/URL, hook command, script set), the
  recorded trust is invalidated and sync refuses again until you re-trust.
- Never put secret values in pack manifests; use `{ fromEnv: VAR }` or
  `{ template: …, requiredEnv: […] }`. AgentPack never resolves them and
  reports environment variables by name only.

See [docs/security-model.md](docs/security-model.md) for the full threat
model.

## Troubleshooting

- **Trust refusal (exit 4).** The pack has executable components and is not
  trusted, or they changed since trust was granted. Read the printed trust
  summary, review the pack, then re-run `agentpack sync --trust <pack>`.
- **Conflict (exit 3).** A file or config key AgentPack owns was modified
  externally since the last sync (including removals of externally modified
  owned paths). Either revert the external edit and re-sync, or re-run with
  `--force` to overwrite — a backup is taken either way
  (`agentpack rollback` restores it).
- **Symlinks unavailable (Windows, some filesystems).** `--mode auto` falls
  back to copying skill directories; `doctor` reports symlink capability.
  Downside: edits in the canonical pack are not reflected until the next sync.
- **Missing environment variables.** `validate` warns (names only) when a
  referenced variable (`fromEnv`, `requiredEnv`, `passEnv`) is not set, and
  `doctor` lists each required variable as set/unset. The value is never read
  or printed — the native agent (or the gateway, in gateway mode) resolves it
  at runtime; in gateway mode a missing variable degrades only that server.
- **Corrupt `.agentpack/state.json`.** `doctor` reports it
  (`state.json is corrupt`). The file is AgentPack-internal bookkeeping; you
  can delete it and re-run `agentpack sync` — AgentPack will re-establish
  ownership, though the first sync afterwards may report conflicts for files
  it can no longer prove it owns (use `--force` after reviewing them).
- **Stale owned files after removing a pack from the workspace.** Sync prunes
  AgentPack-owned paths that are no longer desired; `agentpack remove <pack>`
  does the same explicitly while the pack still exists.

## Known limitations

Native feature sets differ and cannot always be normalized; hooks and
subagents are partly target-specific; AgentPack never executes the tools it
configures; plugin publication remains vendor-specific. The full list:
[docs/limitations.md](docs/limitations.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — compiler pipeline, IR,
  adapter lifecycle, sync transaction, ownership, adoption, trust, secrets.
- [docs/manifest-reference.md](docs/manifest-reference.md) — every field of
  `agentpack.yaml` and `pack.yaml`, with validation rules.
- [docs/adapter-development.md](docs/adapter-development.md) — write a
  third-party target adapter.
- [docs/security-model.md](docs/security-model.md) — threat model and safety
  mechanisms.
- [docs/limitations.md](docs/limitations.md) — known limitations.

## License

MIT — see [LICENSE](LICENSE).
