function parseExistingJson(existing: string | undefined): Record<string, unknown> {
  if (existing === undefined || existing.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (err) {
    throw new Error(`invalid JSON content: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid JSON content: expected a top-level object");
  }
  return parsed as Record<string, unknown>;
}

function parsePointer(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer === "/") {
    throw new Error(`invalid JSON pointer: ${pointer}`);
  }
  return pointer
    .split("/")
    .slice(1)
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function formatJson(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Set `value` at an object-keys-only JSON pointer (e.g. "/mcpServers/github"),
 * creating intermediate objects and preserving all other keys.
 */
export function mergeJsonAtPointer(
  existing: string | undefined,
  pointer: string,
  value: unknown,
): string {
  const root = parseExistingJson(existing);
  const segments = parsePointer(pointer);
  let current = root;
  for (const seg of segments.slice(0, -1)) {
    const next = current[seg];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[seg] = created;
      current = created;
    } else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      throw new Error(`JSON pointer ${pointer} traverses a non-object at segment "${seg}"`);
    }
  }
  current[segments[segments.length - 1]!] = value;
  return formatJson(root);
}

/**
 * Remove the key at a JSON pointer and clean up intermediate objects that
 * became empty along the path.
 */
export function removeJsonAtPointer(existing: string, pointer: string): string {
  const root = parseExistingJson(existing);
  const segments = parsePointer(pointer);
  const stack: Array<{ obj: Record<string, unknown>; key: string }> = [];
  let current = root;
  for (const seg of segments.slice(0, -1)) {
    const next = current[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      // Nothing to remove (absent or non-object); return content unchanged.
      return formatJson(root);
    }
    stack.push({ obj: current, key: seg });
    current = next as Record<string, unknown>;
  }
  delete current[segments[segments.length - 1]!];
  for (let i = stack.length - 1; i >= 0; i--) {
    const { obj, key } = stack[i]!;
    const child = obj[key];
    if (
      typeof child === "object" &&
      child !== null &&
      !Array.isArray(child) &&
      Object.keys(child).length === 0
    ) {
      delete obj[key];
    } else {
      break;
    }
  }
  return formatJson(root);
}

/** Read the value at a JSON pointer, or undefined when absent. */
export function getJsonAtPointer(existing: string, pointer: string): unknown {
  const root = parseExistingJson(existing);
  const segments = parsePointer(pointer);
  let current: unknown = root;
  for (const seg of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
    if (current === undefined) return undefined;
  }
  return current;
}
