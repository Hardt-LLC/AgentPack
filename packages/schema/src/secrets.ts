import { z } from "zod";

/**
 * Canonical environment / secret value.
 *
 * - `{ value }`      — a literal, non-secret value.
 * - `{ fromEnv }`    — resolved by the *native agent* at runtime from the named
 *                      environment variable. AgentPack never resolves it.
 * - `{ template }`   — a string containing `${VAR}` placeholders, resolved by
 *                      the native agent at runtime. `requiredEnv` lists the
 *                      variable names for validation/doctor reporting.
 */
export const envValueSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ fromEnv: z.string().min(1) }).strict(),
  z
    .object({
      template: z.string().min(1),
      requiredEnv: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type EnvValue = z.infer<typeof envValueSchema>;

/** Return the names of environment variables referenced by this value. */
export function referencedEnvVars(value: EnvValue): string[] {
  if ("fromEnv" in value) return [value.fromEnv];
  if ("requiredEnv" in value) return [...value.requiredEnv];
  return [];
}

/**
 * Render an environment value for a native config file *without* resolving
 * secrets. `formatRef` converts a variable name into the target-native
 * reference syntax (e.g. `${VAR}` or `$VAR`).
 */
export function renderEnvValue(value: EnvValue, formatRef: (varName: string) => string): string {
  if ("value" in value) return value.value;
  if ("fromEnv" in value) return formatRef(value.fromEnv);
  return value.template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) =>
    formatRef(name),
  );
}

/** Collect every env var referenced by a record of values. */
export function collectEnvVars(values: Record<string, EnvValue> | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const v of Object.values(values)) out.push(...referencedEnvVars(v));
  return out;
}

/* ------------------------------------------------------------------ */
/* Secret scanning & redaction                                         */
/* ------------------------------------------------------------------ */

export interface SecretFinding {
  /** Name of the pattern that matched, never the matched value. */
  pattern: string;
  /** 1-based line number. */
  line: number;
}

const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "openai-api-key", regex: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/ },
  { name: "private-key-block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "generic-assigned-secret",
    regex: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/i,
  },
];

/** Scan text for likely hardcoded secrets. Findings never contain values. */
export function findHardcodedSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, i) => {
    for (const { name, regex } of SECRET_PATTERNS) {
      if (regex.test(lineText)) findings.push({ pattern: name, line: i + 1 });
    }
  });
  return findings;
}

/** Redact substrings that look like secret values from arbitrary output. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { regex } of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g"),
      "[REDACTED]",
    );
  }
  return out;
}
