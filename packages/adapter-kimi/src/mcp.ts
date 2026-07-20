import { renderEnvRecord, type CanonicalMcpServer } from "@agentpack/schema";

/**
 * Native kimi mcp.json server entry. Keys are emitted in a deterministic
 * order and only when set; env/headers keep "${VAR}" references unresolved.
 */
export function buildMcpServerValue(server: CanonicalMcpServer): Record<string, unknown> {
  const out: Record<string, unknown> = { type: server.transport };
  if (server.transport === "stdio") {
    out.command = server.command;
    if (server.args) out.args = server.args;
    if (server.cwd) out.cwd = server.cwd;
    const env = renderEnvRecord(server.env);
    if (env) out.env = env;
  } else {
    out.url = server.url;
    const headers = renderEnvRecord(server.headers);
    if (headers) out.headers = headers;
  }
  if (server.passEnv) out.passEnv = server.passEnv;
  if (server.startupTimeoutMs !== undefined) out.startupTimeoutMs = server.startupTimeoutMs;
  if (server.toolTimeoutMs !== undefined) out.toolTimeoutMs = server.toolTimeoutMs;
  if (server.approval) out.approval = { default: server.approval.default };
  if (server.allowTools) out.allowTools = server.allowTools;
  if (server.denyTools) out.denyTools = server.denyTools;
  return out;
}
