import type { CanonicalHook } from "@agentpack/schema";

/**
 * kimi hooks.json entry for one canonical hook:
 * { "id", "matcher"?, "command" }. The "all" matcher alias is omitted.
 */
export function buildHookEntry(hook: CanonicalHook): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: hook.id };
  const matcher = normalizeMatcher(hook.matcher);
  if (matcher) entry.matcher = matcher;
  entry.command = hook.command;
  return entry;
}

function normalizeMatcher(matcher: string | undefined): string | undefined {
  if (!matcher || matcher === "all") return undefined;
  return matcher;
}

/**
 * Group hooks by event, preserving pack order. The "notification" event is
 * unsupported by kimi and is dropped here (analyze reports it).
 */
export function groupHooksByEvent(hooks: CanonicalHook[]): Map<string, CanonicalHook[]> {
  const grouped = new Map<string, CanonicalHook[]>();
  for (const hook of hooks) {
    if (hook.event === "notification") continue;
    const list = grouped.get(hook.event);
    if (list) list.push(hook);
    else grouped.set(hook.event, [hook]);
  }
  return grouped;
}
