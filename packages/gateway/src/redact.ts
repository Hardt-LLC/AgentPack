const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|ghp_\w+|AKIA[0-9A-Z]{16}|Bearer\s+\S+)/g;

/**
 * Strips anything that looks like a credential from a message before it is
 * surfaced to the upstream agent.
 */
export function redactSecrets(input: string): string {
  return input.replace(SECRET_PATTERN, "[REDACTED]");
}
