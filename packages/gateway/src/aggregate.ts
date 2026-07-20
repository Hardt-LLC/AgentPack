/**
 * Shared downstream contract plus tool namespacing / filtering / routing.
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DownstreamClient {
  readonly name: string;
  /** Handshake + initial tools/list. Throws on failure (caller degrades the server). */
  start(): Promise<McpTool[]>;
  /** Returns the downstream result unchanged; throws on error/timeout (message pre-redacted). */
  callTool(toolName: string, args: unknown, timeoutMs: number): Promise<unknown>;
  stop(): Promise<void>;
}

export interface ServerTools {
  server: string;
  tools: McpTool[];
  allowTools?: string[];
  denyTools?: string[];
}

export interface RoutedTool {
  server: string;
  toolName: string;
  exposed: McpTool;
}

export const TOOL_NAMESPACE_SEPARATOR = "__";

/**
 * Exposes every downstream tool as `<server>__<toolName>`, applying
 * allowTools / denyTools filters at aggregation time.
 */
export function aggregateTools(servers: ServerTools[]): Map<string, RoutedTool> {
  const routed = new Map<string, RoutedTool>();
  for (const entry of servers) {
    for (const tool of entry.tools) {
      if (entry.allowTools !== undefined && !entry.allowTools.includes(tool.name)) continue;
      if (entry.denyTools !== undefined && entry.denyTools.includes(tool.name)) continue;
      const publicName = `${entry.server}${TOOL_NAMESPACE_SEPARATOR}${tool.name}`;
      routed.set(publicName, {
        server: entry.server,
        toolName: tool.name,
        exposed: { ...tool, name: publicName },
      });
    }
  }
  return routed;
}

export function parseToolName(
  publicName: string,
): { server: string; toolName: string } | undefined {
  const index = publicName.indexOf(TOOL_NAMESPACE_SEPARATOR);
  if (index <= 0 || index >= publicName.length - TOOL_NAMESPACE_SEPARATOR.length) {
    return undefined;
  }
  return {
    server: publicName.slice(0, index),
    toolName: publicName.slice(index + TOOL_NAMESPACE_SEPARATOR.length),
  };
}
