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
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchema(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("x-")) continue;
      if (key === "format" && typeof child === "string" && !STANDARD_FORMATS.has(child)) {
        continue;
      }
      out[key] = sanitizeSchema(child);
    }
    return out as T;
  }
  return value;
}
