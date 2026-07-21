import { parseDocument, stringify } from "yaml";

/**
 * YAML/JSONC merge helpers. Uses YAML documents (a JSON superset, so JSONC
 * files with comments also parse) with object-keys-only pointers, mirroring
 * json-merge semantics: only the addressed key is touched, everything else
 * is preserved. Formatting is normalized on write — callers back up first.
 */

function parseExisting(existing: string | undefined) {
  const doc = parseDocument(existing ?? "", { uniqueKeys: false });
  if (existing !== undefined && existing.trim() !== "" && doc.errors.length > 0) {
    throw new Error(`invalid YAML content: ${doc.errors[0]!.message}`);
  }
  const value = doc.toJS() ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid YAML content: expected a top-level mapping");
  }
  return value as Record<string, unknown>;
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

function formatYaml(obj: Record<string, unknown>): string {
  return stringify(obj);
}

/** Set `value` at an object-keys-only pointer, preserving all other keys. */
export function mergeYamlAtPointer(
  existing: string | undefined,
  pointer: string,
  value: unknown,
): string {
  const root = parseExisting(existing);
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
      throw new Error(`YAML pointer ${pointer} traverses a non-mapping at segment "${seg}"`);
    }
  }
  current[segments[segments.length - 1]!] = value;
  return formatYaml(root);
}

/** Remove the key at a pointer, cleaning up now-empty intermediate mappings. */
export function removeYamlAtPointer(existing: string, pointer: string): string {
  const root = parseExisting(existing);
  const segments = parsePointer(pointer);
  const stack: Array<{ obj: Record<string, unknown>; key: string }> = [];
  let current = root;
  for (const seg of segments.slice(0, -1)) {
    const next = current[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return formatYaml(root);
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
  return formatYaml(root);
}

/** Read the value at a pointer, or undefined when absent. */
export function getYamlAtPointer(existing: string, pointer: string): unknown {
  const root = parseExisting(existing);
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
