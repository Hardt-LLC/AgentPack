import type { CanonicalHook, HookEvent, TargetId } from "@agentpack/schema";

/** Canonical hook event → Claude Code settings.json event name. */
export const CLAUDE_HOOK_EVENTS: Record<HookEvent, string> = {
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  userPromptSubmit: "UserPromptSubmit",
  notification: "Notification",
};

/** Claude Code event name → canonical hook event (for import). */
export const CANONICAL_HOOK_EVENTS: Record<string, HookEvent> = Object.fromEntries(
  Object.entries(CLAUDE_HOOK_EVENTS).map(([canonical, claude]) => [claude, canonical as HookEvent]),
);

/** Canonical matcher aliases → Claude tool-name matchers. */
const MATCHER_ALIASES: Record<string, string | undefined> = {
  shell: "Bash",
  file: "Read|Write|Edit",
  web: "WebFetch|WebSearch",
  // Empty matcher matches all tools; the field is omitted entirely.
  all: undefined,
};

export interface NormalizedMatcher {
  /** The matcher to render, or undefined when the field should be omitted. */
  matcher: string | undefined;
  /** True when an alias changed the matcher (report as "transpiled"). */
  normalized: boolean;
}

export function normalizeMatcher(matcher: string | undefined): NormalizedMatcher {
  if (matcher === undefined) return { matcher: undefined, normalized: false };
  if (Object.hasOwn(MATCHER_ALIASES, matcher)) {
    return { matcher: MATCHER_ALIASES[matcher], normalized: true };
  }
  return { matcher, normalized: false };
}

export interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Render a canonical hook as one Claude settings.json hook entry. */
export function claudeHookEntry(hook: CanonicalHook): ClaudeHookEntry {
  const { matcher } = normalizeMatcher(hook.matcher);
  const entry: ClaudeHookEntry = {
    hooks: [{ type: "command", command: hook.command.join(" ") }],
  };
  if (matcher) {
    // Keep deterministic key order: matcher first, then hooks.
    return { matcher, hooks: entry.hooks };
  }
  return entry;
}

/** Group hooks by Claude event name, preserving declaration order. */
export function groupHooksByEvent(hooks: CanonicalHook[]): Record<string, ClaudeHookEntry[]> {
  const grouped: Record<string, ClaudeHookEntry[]> = {};
  for (const hook of hooks) {
    const event = CLAUDE_HOOK_EVENTS[hook.event];
    (grouped[event] ??= []).push(claudeHookEntry(hook));
  }
  return grouped;
}

/** True when a component targets Claude (no targets list = all targets). */
export function targetsIncludeClaude(targets: TargetId[] | undefined): boolean {
  return targets === undefined || targets.includes("claude");
}
