export type { GatewayServerConfig, GatewayConfig } from "./config.js";
export {
  loadGatewayConfig,
  resolveEnvTemplates,
  GatewayConfigError,
  SERVER_NAME_PATTERN,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_PROTOCOL_VERSION,
  GATEWAY_NAME,
  GATEWAY_VERSION,
} from "./config.js";
export { Gateway, type GatewayStatusEntry } from "./gateway.js";
export { runStdioLoop, type MessageHandler, type StdioLoopOptions } from "./upstream.js";
export {
  aggregateTools,
  parseToolName,
  TOOL_NAMESPACE_SEPARATOR,
  type McpTool,
  type DownstreamClient,
  type ServerTools,
  type RoutedTool,
} from "./aggregate.js";
export { redactSecrets } from "./redact.js";
export * from "./sanitize.js";
