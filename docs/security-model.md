# Security model

## Threat model

AgentPack treats **packs and git pack sources as untrusted input**. A pack can
be authored by anyone; a git source can be re-pointed, and its content changes
over time. The assets at risk:

- **Your machine, via the native agents.** Synced configuration is executable
  by proxy: hook commands run on agent events, stdio MCP servers are launched
  by the agent, remote MCP endpoints receive your prompts and tool calls, and
  malicious skill content steers the model itself.
- **Your existing configuration.** A sync must never clobber hand-maintained
  native config or files it cannot prove it owns.
- **Your secrets.** MCP definitions reference credentials; they must never be
  resolved, copied, logged, or persisted by AgentPack.
- **Your workspace files.** Pack-controlled paths (skill dirs, instruction
  paths, git subdirectories) must not escape their roots.

AgentPack's job is to be a safe conveyor: it _moves_ executable intent from
canonical packs into native config, with explicit consent, without ever
executing that intent itself, and without overstepping what it owns.

## What AgentPack never does

AgentPack executes **nothing** that a pack controls:

- **Skill scripts** (`scripts/`, `*.sh`, `*.py`, …) are copied or symlinked as
  data. They are counted in the trust inventory and hashed, never run.
- **Hook commands** are rendered into native settings files. Only the native
  agent runs them, on its own events.
- **MCP stdio commands** are written into `config.toml` / `.mcp.json` /
  `mcp.json`. Only the native agent launches them.
- **Package lifecycle scripts** — AgentPack does not run `postinstall` or any
  npm-style lifecycle hooks; it installs with plain filesystem operations.
- **Git hooks** — every git invocation uses
  `git -c core.hooksPath=/dev/null …`, so a malicious repository cannot
  execute hooks during clone/fetch/checkout. `GIT_TERMINAL_PROMPT=0` is set so
  a remote can never turn a fetch into an interactive credential prompt.
- **Version probes** (`<agent> --version`) are the only subprocesses spawned
  besides git: fixed argv, no shell, 5-second timeout, failure degrades to a
  warning.

## Trust: the `--trust` flow

Packs with executable components — stdio MCP commands, remote MCP endpoints,
hooks, or script files in skills — require explicit trust before `sync`
touches the filesystem:

1. Sync computes a **trust requirement** per selected pack: counts of local
   MCP commands, remote endpoints, hooks, and script files, plus a
   **content hash** over everything executable (MCP transport/command/args/url,
   hook id/event/command, skill `scripts/` file lists).
2. If a pack requires trust and no matching grant exists, sync **refuses
   before any write** (exit code 4) and prints a human summary:

   ```
   Pack security-review requests:
   - 1 local MCP command(s)
   - 2 executable script(s)
   - 1 hook(s)
   - network access through 1 remote MCP endpoint(s)
   Re-run with: agentpack sync --trust security-review
   ```

3. `agentpack sync --trust <pack>` records the grant in
   `.agentpack/state.json` together with the content hash.
4. **Content-hash invalidation:** when any hashed component changes — an edited
   hook command, a different MCP argument, an added script — the recorded hash
   no longer matches and sync refuses again with "executable components
   changed since trust was granted". Trust can never be carried silently over
   a change.
5. `agentpack remove <pack>` deletes the recorded grant.

`--trust` is deliberately per-pack and per-run-visible: grant it after reading
the summary and reviewing the pack, exactly like auditing a new dependency.

## Filesystem safety

- **Path normalization and escape rejection.** All manifest-controlled paths
  pass through `normalizeRelativePath`/`resolveInside`
  (`packages/filesystem/paths.ts`): absolute paths, empty segments, and `..`
  escapes are rejected, including escapes via symlink ancestors (real paths
  are compared against the real root).
- **No symlink following outside roots.** Skill directories are checked so
  symlinks inside a skill cannot point outside the skill root; markdown links
  that escape the skill root are validation errors.
- **Loop detection.** `doctor` detects symlink loops in owned paths.
- **Atomic writes.** Every file write goes through a write-temp-then-rename
  helper, so a crash mid-sync never leaves a truncated config file.
- **Process lock.** `.agentpack/agentpack.lock` serializes concurrent syncs of
  the same workspace.
- **Backups before mutation.** Every existing path about to be modified or
  removed is backed up under `.agentpack/backups/` first; the 10 most recent
  backups are kept, and `agentpack rollback` restores them.
- **Ownership checksums.** `state.json` records exactly which paths and config
  keys AgentPack owns, with checksums. External modification of an owned item
  is a **conflict** (exit 3) that aborts the sync unless `--force` is given;
  removal of an externally modified item is refused outright.
- **Guarded recursive delete.** Directory removal runs only for paths recorded
  as owned (`guardRemove`), so a corrupted plan cannot escalate into deleting
  arbitrary directories.

## Adoption guarantees

Adoption replaces user-owned configuration, so it carries the strongest safety
invariants in the codebase:

- **Backup-before-modify, never after.** Every adoption path — duplicate MCP
  keys in `gateway setup --adopt`, blocking paths in `sync --adopt` — creates
  its backup before the native file or directory is touched. Tests assert the
  backup contains the _pre-adoption_ content.
- **Nothing is adopted without a restorable record.** Config keys are recorded
  inline in `state.json` (`adopted.configKeys`) with their exact value and a
  checksum; whole paths are moved into a timestamped backup and recorded with
  the backup id (`adopted.paths`). There is no code path that deletes an
  unmanaged path during adoption without a prior backup.
- **Checksum verification before reclaim.** The gateway's reclaim of
  previously synced keys verifies the on-disk value against the recorded
  checksum and refuses (`--force` overrides, still with a backup); duplicate
  detection matches server names case-insensitively but only ever adopts —
  never guesses at — entries whose names match canonical servers.
- **Restoration semantics.** `agentpack uninstall` merges adopted keys back
  with their recorded values and copies adopted paths back from their backups.
  A path that exists at uninstall time and is not AgentPack-owned is left in
  place and reported rather than overwritten. Restored entries are dropped
  from state.
- **Adopted config values may contain secrets.** Pre-AgentPack MCP entries
  were hand-written, so their recorded values can include literal credentials.
  They stay local in `.agentpack/state.json` (machine-local, not committed)
  and are never logged or printed — adoption reports keys by path and pointer
  only. Treat `state.json` accordingly if your pre-existing config contained
  secrets: adoption preserves them for restoration, it does not scrub them.

## Secret handling rules

- Canonical secret-bearing fields (`env`, `headers`) use `{ fromEnv: VAR }` or
  `{ template: …, requiredEnv: […] }`. **AgentPack never resolves them** —
  generation renders the target-native reference syntax (`${VAR}`) and writes
  the reference. Only the native agent resolves values, at runtime, in its own
  process.
- Secrets are **never written** to `state.json`, logs, plans, diffs, backups,
  or generated files. Backups copy existing native config files verbatim —
  which, by the rendering rule above, contain references rather than resolved
  values for anything AgentPack generated.
- Environment reporting is **names-only**: `validate` and `doctor` warn that
  `GITHUB_TOKEN is not set`; they never read or display the value.
- Loading scans the raw `pack.yaml` for likely hardcoded secrets (OpenAI keys,
  GitHub tokens, Slack tokens, AWS access keys, bearer tokens, private-key
  blocks, generic `api_key/secret/password/token = …` assignments) and emits
  warnings containing the pattern name and line number — never the matched
  text. `redactSecrets` applies the same patterns to arbitrary output.
- **Acknowledging a false positive:** there is currently no inline ignore
  mechanism. Fix the finding — move the value to a `{ fromEnv: VAR }` or
  template reference — or restructure the line so it no longer matches (the
  finding is a warning and does not block sync).
- **Imports** parse native `${VAR}` strings back into `fromEnv`/`template`
  forms, so imported manifests contain references, not secrets.

## Gateway security notes

The MCP gateway changes _where_ secrets are resolved, not whether they are:

- **`gateway.json` contains references, not values.** `agentpack gateway
setup` renders `env`/`headers` through the same `${VAR}` rendering as every
  other generated file. The file is written atomically at the workspace root
  and holds server definitions plus the launcher record — nothing resolved.
- **Secrets are resolved only inside the gateway process.** At startup the
  gateway substitutes `${VAR}` placeholders from its own environment, in
  memory. Values never touch disk, logs, or the agent-facing protocol.
- **Missing variables degrade rather than leak.** A server whose referenced
  variables are unset fails its handshake, is marked degraded, and contributes
  zero tools; the error names the missing variables, never their values, and
  every other server keeps serving.
- **Downstream stdio children get a minimal environment** — `PATH`, `HOME`,
  the names in `passEnv`, and the server's resolved `env` entries. Nothing
  else from the gateway's environment is inherited.
- **Error redaction.** Downstream stderr lines and error messages pass through
  secret redaction (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`) before being logged
  or returned to the agent in JSON-RPC errors.
- **Trust still applies — the gateway executes on the agent's behalf.** The
  gateway is itself the executable that spawns downstream stdio MCP servers
  and calls remote endpoints, so gateway mode does not bypass the trust model:
  the trust content hash covers MCP transport/command/args/URL definitions,
  and changing any of them invalidates the recorded grant exactly as in
  non-gateway mode. The gateway launcher installed into agent configs is a
  plain stdio entry pointing at your CLI — it carries no pack content.
- The reclaim step in `gateway setup` only removes MCP keys recorded as owned
  in `state.json` whose checksum still matches (`--force` overrides); it backs
  up every file first, like any other mutation.

## Merge safety

Sync modifies **only AgentPack-owned keys** in shared config files:

- JSON merges (`json-merge`) set a single JSON pointer (e.g.
  `/mcpServers/github` in `.mcp.json`, `/hooks/PreToolUse` in
  `settings.json`); every other key is preserved byte-for-semantically.
- TOML merges (`toml-merge`) set a single table path
  (`[mcp_servers.<name>]` in `config.toml`); the rest of the file is
  preserved.
- Markdown instructions upsert a delimited **managed section**
  (`managed-section` strategy) or append (`append` strategy); content outside
  the managed markers is untouched.

Removal is symmetric: `agentpack remove` unmerges only keys whose recorded
checksum still matches, and skips everything else with an explicit reason.
Unmanaged configuration — anything you wrote by hand outside the owned
pointers/sections — is never claimed, never merged into, and never deleted.
