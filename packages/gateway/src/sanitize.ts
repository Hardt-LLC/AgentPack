/**
 * JSON Schema sanitization for aggregated tools.
 *
 * Some downstream servers (e.g. Google Stitch) decorate their tool schemas
 * with vendor extension keywords (`x-google-identifier`,
 * `x-google-enum-descriptions`, ...). Strict JSON Schema validators used by
 * MCP clients (ajv strict mode and friends) reject unknown keywords, fail to
 * compile the containing `$defs`, and then report every `$ref` into those
 * definitions as unresolvable — failing the whole gateway server.
 *
 * JSON Schema explicitly allows `x-` extensions and they carry no validation
 * semantics, so we strip them recursively on aggregation.
 */
/**
 * Standard JSON Schema formats. Protobuf-style formats (int32, uint64, ...)
 * used by Google schemas break strict validators that reject unknown formats;
 * `format` is annotation-only, so dropping non-standard ones is lossless.
 */
const STANDARD_FORMATS = new Set([
  "date",
  "time",
  "date-time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
  "uuid",
  "byte",
]);

export function sanitizeSchema<T>(value: T): T {
  const cleaned = stripExtensions(value);
  return repairDanglingRefs(cleaned);
}

function stripExtensions<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripExtensions(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("x-")) continue;
      if (key === "format" && typeof child === "string" && !STANDARD_FORMATS.has(child)) {
        continue;
      }
      out[key] = stripExtensions(child);
    }
    return out as T;
  }
  return value;
}

const LOCAL_REF = /^#\/(?:\$defs|definitions)\/([^/]+)$/;

/**
 * Replace root-local $refs whose target definition is missing (seen in the
 * wild: stitch's upload_design_md outputSchema references a $defs entry the
 * server never ships). A dangling ref makes strict validators reject the
 * whole schema; replacing it with `true` keeps the schema compilable.
 */
function repairDanglingRefs<T>(schema: T): T {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const root = schema as Record<string, unknown>;
  const defined = new Set<string>([
    ...Object.keys((root["$defs"] as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((root["definitions"] as Record<string, unknown> | undefined) ?? {}),
  ]);
  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const ref = record["$ref"];
      if (typeof ref === "string") {
        const match = LOCAL_REF.exec(ref);
        if (match && !defined.has(match[1]!)) {
          const rest = { ...record };
          delete rest["$ref"];
          // A lone dangling $ref becomes `true` (accept anything).
          return Object.keys(rest).length === 0 ? true : rest;
        }
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) out[key] = walk(child);
      return out;
    }
    return node;
  }
  return walk(schema) as T;
}
