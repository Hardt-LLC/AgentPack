import { parse, stringify } from "smol-toml";

type TomlObject = Record<string, unknown>;

function parseExistingToml(existing: string | undefined): TomlObject {
  if (existing === undefined || existing.trim() === "") return {};
  return parse(existing) as TomlObject;
}

function validateTablePath(table: string[]): void {
  if (table.length === 0 || table.some((seg) => seg === "")) {
    throw new Error(`invalid TOML table path: ${JSON.stringify(table)}`);
  }
}

/**
 * Set `value` (a plain object) at a nested TOML table path such as
 * ["mcp_servers", "github"], preserving unrelated tables and keys.
 */
export function mergeTomlAtTable(
  existing: string | undefined,
  table: string[],
  value: unknown,
): string {
  validateTablePath(table);
  const root = parseExistingToml(existing);
  let current = root;
  for (const seg of table.slice(0, -1)) {
    const next = current[seg];
    if (next === undefined) {
      const created: TomlObject = {};
      current[seg] = created;
      current = created;
    } else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      current = next as TomlObject;
    } else {
      throw new Error(`TOML table path [${table.join(".")}] traverses a non-table at "${seg}"`);
    }
  }
  current[table[table.length - 1]!] = value;
  return stringify(root);
}

/** Remove the table at a nested TOML table path. */
export function removeTomlAtTable(existing: string, table: string[]): string {
  validateTablePath(table);
  const root = parseExistingToml(existing);
  const stack: Array<{ obj: TomlObject; key: string }> = [];
  let current = root;
  for (const seg of table.slice(0, -1)) {
    const next = current[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return stringify(root);
    }
    stack.push({ obj: current, key: seg });
    current = next as TomlObject;
  }
  delete current[table[table.length - 1]!];
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
  return stringify(root);
}

/** Read the value at a nested TOML table path, or undefined when absent. */
export function getTomlAtTable(existing: string, table: string[]): unknown {
  validateTablePath(table);
  const root = parseExistingToml(existing);
  let current: unknown = root;
  for (const seg of table) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as TomlObject)[seg];
    if (current === undefined) return undefined;
  }
  return current;
}
