# Manifest reference

AgentPack has two manifest files, both validated with strict zod schemas
(`packages/schema/pack.ts`). **Unknown fields are rejected** (`.strict()`
everywhere) — a typo is a validation error, not a silently ignored option.

Common rules:

- `apiVersion` must be exactly `agentpack.dev/v1alpha1`.
- Names (pack names, skill names, instruction/hook ids, MCP server names) must
  match `^[a-z0-9][a-z0-9-]*$`, length 1–64.
- Relative paths inside manifests must stay within their root (pack root or
  workspace root). Absolute paths, empty segments, and `..` escapes are
  rejected, including escapes through symlink ancestors.

## `agentpack.yaml` — workspace manifest

| Field        | Type                             | Required          | Description                              |
| ------------ | -------------------------------- | ----------------- | ---------------------------------------- |
| `apiVersion` | literal `agentpack.dev/v1alpha1` | yes               | Schema version.                          |
| `kind`       | literal `Workspace`              | yes               | Document kind.                           |
| `packs`      | array of pack sources            | no (default `[]`) | Packs belonging to this workspace.       |
| `profiles`   | map of name → profile            | no (default `{}`) | Named selections of packs/targets/scope. |
| `gateway`    | object                           | no                | MCP gateway mode (see below).            |

### Pack source

Each entry in `packs` is exactly one of:

**Local path:**

| Field  | Type   | Required | Description                                     |
| ------ | ------ | -------- | ----------------------------------------------- |
| `path` | string | yes      | Pack directory, relative to the workspace root. |

**Git source:**

| Field                 | Type          | Required | Description                                               |
| --------------------- | ------------- | -------- | --------------------------------------------------------- |
| `source.type`         | literal `git` | yes      | Source type.                                              |
| `source.url`          | string        | yes      | Git URL to clone.                                         |
| `source.ref`          | string        | no       | Tag/branch/commit to resolve. Default: `HEAD`.            |
| `source.subdirectory` | string        | no       | Pack directory inside the checkout (must stay inside it). |

Git sources are cloned into `.agentpack/cache/git/`, resolved to an immutable
commit, and pinned in `.agentpack/lock.json` (`{ url, ref, commit,
subdirectory }` keyed by `url#subdirectory`). `agentpack update` re-resolves
refs and rewrites the lockfile.

### Profile

A profile names a reusable selection. The profile named `default` is used when
no `--profile` flag is given; if no profiles exist at all, the selection is
all packs × all targets with `project` scope and `auto` install mode.

| Field         | Type                                     | Required | Default   | Description                     |
| ------------- | ---------------------------------------- | -------- | --------- | ------------------------------- |
| `packs`       | array of pack names (min 1)              | yes      | —         | Packs included in this profile. |
| `targets`     | array of `codex`/`claude`/`kimi` (min 1) | yes      | —         | Targets to sync to.             |
| `scope`       | `project` \| `user`                      | no       | `project` | Install scope.                  |
| `installMode` | `auto` \| `symlink` \| `copy`            | no       | `auto`    | Skill install mode.             |

CLI flags `--targets`, `--scope`, `--mode` override the profile values.

### `gateway`

Gateway mode: instead of merging each MCP server into every target's native
config, targets get a single entry pointing at the AgentPack MCP gateway,
which fans out to the canonical servers at runtime (see
[architecture.md](architecture.md#the-mcp-gateway-layer)).

| Field     | Type        | Required | Default       | Description                                                                                                           |
| --------- | ----------- | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled` | boolean     | no       | `false`       | When true, plan/sync skip individual MCP server artifacts and inject the single gateway entry instead.                |
| `name`    | name string | no       | `"agentpack"` | Name of the gateway MCP entry installed into each target. Must not collide with an MCP server name defined by a pack. |

`enabled: true` requires a `<workspace>/gateway.json` written by
`agentpack gateway setup`; planning without it produces a warning. Skills,
instructions, and hooks are unaffected by this field.

Example:

```yaml
apiVersion: agentpack.dev/v1alpha1
kind: Workspace

packs:
  - path: ./packs/security-review
  - source:
      type: git
      url: https://github.com/acme/agent-extensions.git
      ref: v1.4.0
      subdirectory: packs/team-skills

profiles:
  default:
    packs: [security-review]
    targets: [codex, claude, kimi]
    scope: project
    installMode: auto

gateway:
  enabled: true
  name: agentpack
```

## `pack.yaml` — pack manifest

| Field        | Type                             | Required | Description     |
| ------------ | -------------------------------- | -------- | --------------- |
| `apiVersion` | literal `agentpack.dev/v1alpha1` | yes      | Schema version. |
| `kind`       | literal `Pack`                   | yes      | Document kind.  |
| `metadata`   | object                           | yes      | Pack identity.  |
| `spec`       | object                           | yes      | Pack contents.  |

### `metadata`

| Field         | Type            | Required | Description                              |
| ------------- | --------------- | -------- | ---------------------------------------- |
| `name`        | name string     | yes      | Pack name; must be unique per workspace. |
| `version`     | string (min 1)  | yes      | Pack version (free-form string).         |
| `description` | string          | no       | Short description.                       |
| `license`     | string          | no       | License identifier.                      |
| `keywords`    | array of string | no       | Keywords.                                |

### `spec.skills[]`

| Field  | Type   | Required | Description                                                          |
| ------ | ------ | -------- | -------------------------------------------------------------------- |
| `path` | string | yes      | Skill directory, relative to the pack root. Must contain `SKILL.md`. |

Skill validation (`packages/core/skill.ts`): `SKILL.md` must exist with valid
YAML frontmatter containing `name` and `description`; `name` must match the
name charset **and equal the directory name**; symlinks inside the skill must
not escape the skill root; local markdown links must resolve inside the skill
root (missing targets are warnings, escapes are errors). Skill names must be
unique within a pack, and two selected packs providing the same skill name is
a workspace validation error.

### `spec.instructions[]`

| Field           | Type                                 | Required                | Default           | Description                                                                  |
| --------------- | ------------------------------------ | ----------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `id`            | name string                          | yes                     | —                 | Instruction id; unique within the pack. Also used as the managed-section id. |
| `path`          | string                               | yes                     | —                 | Markdown file, relative to the pack root.                                    |
| `scope`         | `global` \| `project` \| `directory` | no                      | `project`         | Where the instruction is installed.                                          |
| `directory`     | string                               | with `scope: directory` | —                 | Directory (relative to the project root) receiving the instruction file.     |
| `priority`      | integer                              | no                      | `100`             | Ordering hint for merged sections.                                           |
| `targets`       | array of target ids                  | no                      | all targets       | Restrict which targets receive this instruction.                             |
| `mergeStrategy` | `managed-section` \| `append`        | no                      | `managed-section` | Upsert an AgentPack-managed section, or append.                              |

Validation rule: `scope: directory` **requires** `directory`.

### `spec.mcpServers.<name>`

Server names must match the name charset. Two selected packs defining the same
server name with different configuration is a workspace validation error
(identical definitions are allowed).

| Field              | Type                            | Required          | Default | Description                                       |
| ------------------ | ------------------------------- | ----------------- | ------- | ------------------------------------------------- |
| `transport`        | `stdio` \| `http` \| `sse`      | yes               | —       | Transport.                                        |
| `command`          | string (min 1)                  | with `stdio`      | —       | Executable to launch. Forbidden for `http`/`sse`. |
| `args`             | array of string                 | no                | —       | Command arguments.                                |
| `cwd`              | string                          | no                | —       | Working directory for the command.                |
| `url`              | string (min 1)                  | with `http`/`sse` | —       | Endpoint URL. Forbidden for `stdio`.              |
| `headers`          | map of string → env value       | no                | —       | HTTP headers (env-value forms allowed).           |
| `env`              | map of string → env value       | no                | —       | Environment for a stdio server (env-value forms). |
| `passEnv`          | array of variable names (min 1) | no                | —       | Variable names the native agent passes through.   |
| `startupTimeoutMs` | positive integer                | no                | —       | Startup timeout in milliseconds.                  |
| `toolTimeoutMs`    | positive integer                | no                | —       | Per-tool-call timeout in milliseconds.            |
| `enabled`          | boolean                         | no                | `true`  | Disabled servers are skipped by all targets.      |
| `allowTools`       | array of string                 | no                | —       | Tool allowlist (target support varies).           |
| `denyTools`        | array of string                 | no                | —       | Tool denylist (target support varies).            |
| `approval.default` | `prompt` \| `always` \| `never` | no                | —       | Default tool-approval policy.                     |
| `extensions`       | map of string → unknown         | no                | —       | Target-specific extra data.                       |

Transport validation rules: `stdio` requires `command` and forbids `url`;
`http` and `sse` require `url` and forbid `command`.

**Environment value forms** (`packages/schema/secrets.ts`) — used by `env` and
`headers`:

| Form                                               | Meaning                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `{ value: "literal" }`                             | A literal, non-secret value.                                                                                              |
| `{ fromEnv: "VAR" }`                               | Resolved by the native agent at runtime; AgentPack renders a `${VAR}` reference and never reads the value.                |
| `{ template: "x-${VAR}-y", requiredEnv: ["VAR"] }` | Literal text containing `${VAR}` placeholders; `requiredEnv` (min 1) lists the variables for validation/doctor reporting. |

Referenced variables that are not set in the environment produce **warnings**
(names only). Prefer `fromEnv`/`template` over `value` for anything sensitive;
loading scans the raw manifest for hardcoded secrets and warns per finding
(pattern name + line number, never the value).

### `spec.hooks[]`

| Field        | Type                    | Required | Default     | Description                                                       |
| ------------ | ----------------------- | -------- | ----------- | ----------------------------------------------------------------- |
| `id`         | name string             | yes      | —           | Hook id.                                                          |
| `event`      | hook event              | yes      | —           | See the event list below.                                         |
| `matcher`    | string                  | no       | —           | Tool matcher (target-specific normalization).                     |
| `command`    | array of string (min 1) | yes      | —           | argv array; **executed by the native agent**, never by AgentPack. |
| `targets`    | array of target ids     | no       | all targets | Restrict which targets receive this hook.                         |
| `extensions` | map of string → unknown | no       | —           | Target-specific extra data.                                       |

Hook events: `preToolUse`, `postToolUse`, `sessionStart`, `sessionEnd`,
`userPromptSubmit`, `notification`.

Matcher aliases understood by the Claude adapter: `shell` → `Bash`, `file` →
`Read|Write|Edit`, `web` → `WebFetch|WebSearch`, `all` → matcher omitted. The
kimi adapter passes matchers through (omitting `all`) and does not support the
`notification` event. Codex has no hook system.

### `spec.plugin`

| Field                        | Type            | Required | Default | Description                        |
| ---------------------------- | --------------- | -------- | ------- | ---------------------------------- |
| `enabled`                    | boolean         | no       | `false` | Include plugin metadata in builds. |
| `interface.displayName`      | string          | no       | —       | Display name.                      |
| `interface.shortDescription` | string          | no       | —       | Short description.                 |
| `interface.longDescription`  | string          | no       | —       | Long description.                  |
| `interface.author`           | string          | no       | —       | Author.                            |
| `interface.homepage`         | string          | no       | —       | Homepage URL.                      |
| `interface.categories`       | array of string | no       | —       | Categories.                        |

`agentpack build` uses this to produce per-target plugin manifests
(`.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`,
`kimi.plugin.json`).

### `spec.targets.<target>`

| Field     | Type    | Required | Default | Description                                   |
| --------- | ------- | -------- | ------- | --------------------------------------------- |
| `enabled` | boolean | no       | `true`  | Set `false` to skip this pack for the target. |

Keys: `codex`, `claude`, `kimi`. A pack disabled for every selected target is
dropped from the selection entirely.

### `spec.extensions.<target>`

Free-form per-target data (`map of string → unknown`, keys `codex`, `claude`,
`kimi`). Contents are not validated by the canonical schema; they are passed
verbatim to exactly one adapter as `pack.targetExtensions.<target>`.

Documented extension points:

- `spec.extensions.claude.agents` — array of `{ name, description, content }`
  subagent definitions; rendered as Claude subagent markdown files
  (`agents/<name>.md`) in plugin bundles.
- `spec.extensions.codex` — emitted as `x-codex` in the Codex plugin manifest.

## Full example

```yaml
apiVersion: agentpack.dev/v1alpha1
kind: Pack

metadata:
  name: security-review
  version: 0.1.0
  description: Shared security-review workflows
  license: MIT
  keywords: [security, review]

spec:
  skills:
    - path: ./skills/security-review

  instructions:
    - id: security-baseline
      path: ./instructions/common.md
      scope: project
      priority: 100
      targets: [codex, claude, kimi]

  mcpServers:
    github:
      transport: http
      url: https://example.invalid/mcp
      headers:
        Authorization:
          fromEnv: GITHUB_TOKEN
      approval:
        default: prompt

    local-security-tools:
      transport: stdio
      command: node
      args: ["./servers/security-tools.mjs"]
      cwd: .
      env:
        SECURITY_MODE:
          value: readonly
      passEnv: [HOME]

  hooks:
    - id: block-dangerous-shell
      event: preToolUse
      matcher: shell
      command: [node, ./hooks/check-shell.mjs]
      targets: [claude, kimi]

  plugin:
    enabled: true
    interface:
      displayName: Security Review
      shortDescription: Shared security review workflows

  targets:
    codex: { enabled: true }
    claude: { enabled: true }
    kimi: { enabled: true }

  extensions:
    claude:
      agents:
        - name: security-auditor
          description: Deep security review subagent
          content: |
            You are a security auditing specialist…
```
