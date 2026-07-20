# Known limitations

AgentPack normalizes what the three targets have in common. Where native
feature sets genuinely diverge, it reports the divergence instead of
pretending it away — per-component, per-target capability findings
(`native` / `transpiled` / `degraded` / `unsupported`) in `validate`, `plan`,
and `sync` output. The concrete gaps, as of the current adapters:

## Native features cannot always be normalized

- **Codex has no hook system.** Canonical hooks are `unsupported` for Codex;
  they are not installed (they are still exported into the plugin bundle).
- **Codex has no `allowTools`/`denyTools`.** Tool allow/denylists have no
  `config.toml` equivalent and are dropped (degraded finding; remediation:
  rely on Codex's approval system). `sse` MCP servers are degraded because
  Codex has deprecated the transport.
- **Claude `.mcp.json` cannot express `passEnv`, `approval`, or
  `allowTools`/`denyTools`.** They are dropped with degraded findings; the
  remediation for `passEnv` is to declare each variable explicitly in `env`
  with `{ fromEnv: VAR }`, which renders as a `${VAR}` reference.
- **Kimi `hooks.json` does not support the `notification` event.** Such hooks
  are dropped (unsupported finding; remediation: use `sessionEnd` or a skill).

Strictness modes let you choose how much this matters: `permissive` warns,
`strict` fails on degraded/unsupported, `portable` additionally requires
components to be usable across every selected target.

Note: in [gateway mode](../README.md#mcp-gateway-mode) the MCP-related drops
above disappear — `allowTools`/`denyTools` are enforced by the gateway at
aggregation time and `passEnv`/`env` are resolved inside the gateway process,
uniformly for every target. The hook gaps remain.

## Hooks and subagents are partly target-specific

- Claude subagents exist only as the `spec.extensions.claude.agents` extension
  point and are emitted into Claude plugin bundles; there is no canonical
  cross-target subagent concept yet.
- Hook **matchers are target-native concepts** wearing a thin canonical
  alias layer (`shell`, `file`, `web`, `all` for Claude). A matcher written
  for one target's tool names may match nothing on another.
- Codex receives no hooks at all (above). A hook meant to guard "any tool
  call" must be declared per target via the hook's `targets` list and accepted
  as absent on Codex.

## AgentPack does not execute configured tools

AgentPack is a compiler/installer, not a runtime. It never runs skill scripts,
hook commands, or MCP servers — the **native agent** does, under its own
sandboxing and approval rules. A green `agentpack validate` means the
configuration is well-formed and installable; it says nothing about the
runtime behavior or safety of what it configures. Review packs and use
`--trust` deliberately (see [security-model.md](security-model.md)).

## Native agent updates may require adapter updates

Detection is best-effort (executable on `PATH` plus a `--version` probe with a
5-second timeout), and the generated config layouts target the current native
formats of each agent. When a vendor changes its config schema — new fields,
renamed files, deprecated transports — the corresponding adapter must be
updated and AgentPack re-synced. Adapters do not version-negotiate beyond
reporting the detected version.

## Plugin publication remains vendor-specific

`agentpack build` produces **bundles only** — per-target directory trees under
`dist/<target>/<pack>/` (`.codex-plugin/plugin.json`,
`.claude-plugin/plugin.json`, `kimi.plugin.json`, plus skills/hooks/MCP
assets). Publishing to a vendor marketplace or plugin registry, signing, and
version negotiation with a registry are out of scope.

## Multi-pack hook collisions are last-write-wins

Two selected packs that define hooks for the same event on the same target
merge into the same config key (e.g. `/hooks/PreToolUse` in Claude's
`settings.json`). The merged value is whichever pack was planned last — there
is no conflict detection across packs for hooks, unlike skills (duplicate
names are an error) and MCP servers (divergent definitions are an error).

## Instruction merge is section-based, not semantic

Instructions are combined into `AGENTS.md`/`CLAUDE.md` as delimited managed
sections (or appended, with `mergeStrategy: append`). AgentPack does not
deduplicate, order beyond the `priority` hint, or semantically merge
contradictory instruction content — if two packs tell the agent opposite
things, both texts land in the file and the model sees both.

## Gateway limitations

- **Tools are namespaced.** Agents see `server__tool` (e.g.
  `github__create_issue`), not the original tool names. Agent prompts or
  skills that reference unprefixed tool names need adjusting.
- **`tools/list` is cached at gateway startup.** The gateway fetches each
  downstream's tool list during its handshake and serves that snapshot;
  downstream tools added or removed later are not visible until the gateway
  process is restarted (it advertises `listChanged: false`).
- **Tools only.** Resources and prompts are not proxied — the gateway answers
  `initialize`, `ping`, `tools/list`, and `tools/call`; everything else gets
  "Method not found".
- **`sse` is treated as HTTP request/response.** The legacy SSE transport uses
  the same Streamable-HTTP POST path (JSON or `text/event-stream` bodies are
  both accepted); no server-push event channel is consumed, and no session
  teardown is sent on shutdown.
- **A degraded server stays at zero tools until restart.** A server that fails
  its startup handshake (missing env vars, spawn failure, unreachable URL) is
  marked degraded for the life of the gateway process — there is no retry or
  reconnection; fix the cause and restart the gateway (i.e. the agent
  session).
- **One gateway entry means one blast radius for config mistakes.** A broken
  `gateway.json` takes out all MCP servers for the targets pointing at it,
  instead of one; `agentpack gateway uninstall` + `agentpack sync` restores
  the individual servers.

## Adoption and uninstall limits

- **Restoration is per-target.** Ownership and adopted state are recorded per
  target; `agentpack uninstall --targets claude` removes and restores only
  Claude's config. Other targets keep their AgentPack-managed state until
  uninstalled themselves.
- **Adopted paths age out with backup pruning.** Sync prunes
  `.agentpack/backups/` to the 10 most recent backups (`pruneBackups`). An
  adopted path whose backup has aged out can no longer be restored — uninstall
  reports it as skipped (`cannot restore`). Long-lived workspaces that rely on
  adoption should keep backup pruning in mind.
- **Adopted keys are merged back unconditionally.** If you hand-recreate a
  same-name entry after it was adopted, uninstall overwrites it with the
  recorded original value. Adopted _paths_ are stricter: they are only
  restored when the path is absent — an existing non-owned path is left in
  place and reported.
- **Uninstall does not remove trust grants.** `state.json`'s `trust` entries
  survive `agentpack uninstall` (only `agentpack remove <pack>` clears a
  pack's grant). Re-onboarding later reuses the recorded grants, provided the
  executable content hash is unchanged.
- **Uninstall does not delete bookkeeping.** `gateway.json`, `state.json`,
  and the backups directory remain; only native target configuration is
  touched.

## Collection and automation limits

- **Collect is user-scope only.** It reads each target's user-level native
  config (`~/.claude`, `~/.codex`, `$KIMI_CODE_HOME`); servers or skills
  installed at project scope in some other project are not seen.
- **Instructions are not collected.** Plugin/agent instructions are
  vendor-specific and too noisy to review mechanically — only MCP servers and
  skills flow into inbox packs.
- **Inbox packs are never auto-profiled.** `collect` adds the pack path to
  `agentpack.yaml` but never to a profile; if you want an inbox entry shared,
  `promote` the pack or move the entries into a profiled pack yourself.
- **Dismissed items stay collected.** Skipping an inbox entry during review
  does not teach collect to ignore it — and deleting the inbox pack (or an
  entry in it) means the next native change re-collects the item, since it is
  still present in the agent and no longer known to the workspace. To truly
  dismiss an item, uninstall it from the agent.
- **The watch service is per machine.** `agentpack service install` writes a
  launchd plist or systemd unit on the local machine only; teammates and other
  machines need their own install, and the unit embeds the local CLI path and
  workspace root.
- **The session collect hook is Claude-only.** Other targets report "no hook
  system"; their collection path is the watch service or manual
  `agentpack collect`.

## Other MVP boundaries

- **Target ids are a closed enum** (`codex` | `claude` | `kimi`) in the
  schema; third-party adapters need `targetIdSchema` widened (see
  [adapter-development.md](adapter-development.md)).
- **No secret-finding suppression syntax.** A hardcoded-secret warning can
  only be resolved by moving the value to an env reference or rewording the
  line.
- **`state.json` is machine-local** (it stores absolute paths). Sync state,
  trust grants, and backups do not travel with the repository; each machine
  re-establishes them on first sync. Only `.agentpack/lock.json` is meant to
  be committed.
- **Imports are partial.** Hook definitions are not imported from native
  config, and global-scope instructions are imported as project scope.
