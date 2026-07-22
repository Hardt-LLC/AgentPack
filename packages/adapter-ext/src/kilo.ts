import path from "node:path";

import type { CanonicalMcpServer, TargetAdapter } from "@agentpack/schema";

import {
  defineSimpleAdapter,
  envRecordFromNative,
  renderEnv,
  vscodeGlobalStorage,
} from "./factory.js";

const KILO_EXTENSION_ID = "kilocode.kilo-code";

/**
 * Native kilo.jsonc MCP entry (opencode-style): stdio is
 * { type: "local", command: [...], environment? } with the command as an
 * ARRAY; remote is { type: "remote", url, headers? }. Env references use the
 * opencode `{env:VAR}` brace syntax (the data sheet does not pin this down;
 * kilo.jsonc is opencode-derived).
 */
function kiloServerValue(server: CanonicalMcpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    const out: Record<string, unknown> = {
      type: "local",
      command: [server.command!, ...(server.args ?? [])],
    };
    const environment = renderEnv(server.env, "brace");
    if (environment) out.environment = environment;
    return out;
  }
  const out: Record<string, unknown> = { type: "remote", url: server.url };
  const headers = renderEnv(server.headers, "brace");
  if (headers) out.headers = headers;
  return out;
}

function parseKiloServer(name: string, raw: unknown): Omit<CanonicalMcpServer, "name"> | undefined {
  void name;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === false ? false : true;

  if (
    record.type === "local" &&
    Array.isArray(record.command) &&
    record.command.length > 0 &&
    record.command.every((part) => typeof part === "string")
  ) {
    const [command, ...args] = record.command as string[];
    const spec: Record<string, unknown> = { transport: "stdio", command, enabled };
    if (args.length > 0) spec.args = args;
    const environment = envRecordFromNative(record.environment);
    if (environment) spec.env = environment;
    return spec as Omit<CanonicalMcpServer, "name">;
  }

  if (record.type === "remote" && typeof record.url === "string" && record.url.length > 0) {
    const spec: Record<string, unknown> = { transport: "http", url: record.url, enabled };
    const headers = envRecordFromNative(record.headers);
    if (headers) spec.headers = headers;
    return spec as Omit<CanonicalMcpServer, "name">;
  }

  return undefined;
}

/**
 * Kilo Code — CURRENT generation only (standalone `kilo` CLI + rebuilt
 * extension, opencode-derived). The legacy Roo-fork extension used the
 * kilocode.kilo-code globalStorage, mcp_settings.json with `mcpServers`, and
 * .kilocode/ conventions; when only that layout is present, detection reports
 * a warning instead of writing legacy config.
 *
 * - MCP: top-level "mcp" key inside kilo.jsonc at ~/.config/kilo and at the
 *   project root. kilo.jsonc is JSONC — merged through the YAML engine
 *   (format "yaml"), which parses JSON superset syntax plus comments.
 * - Skills: .kilocode/skills/<name>/SKILL.md at project scope (community-
 *   verified; auto-discovered by the CLI). No documented global skills
 *   directory → user-scope skills analyze as "unsupported".
 * - Instructions: root AGENTS.md (both generations auto-load it). Global
 *   instructions live in the kilo.jsonc `instructions` array — not a markdown
 *   file, so user-scope instructions are unsupported for MVP.
 * - Hooks: no documented lifecycle-hooks feature (the CLI's opencode-style
 *   JS/TS plugins are out of scope) — unsupported.
 */
export const kiloAdapter: TargetAdapter = defineSimpleAdapter({
  id: "kilo",
  executables: ["kilo"],
  userConfigRoot: (ctx) => path.join(ctx.homeDir, ".config", "kilo"),
  projectConfigRoot: (ctx) => path.join(ctx.projectRoot, ".kilo"),
  legacyLayout: {
    paths: (ctx) => [
      path.join(ctx.homeDir, ".kilocode"),
      vscodeGlobalStorage(ctx, KILO_EXTENSION_ID),
    ],
    warning:
      "only the legacy Kilo Code layout was detected (~/.kilocode or kilocode.kilo-code globalStorage); the current layout is ~/.config/kilo/kilo.jsonc",
  },
  skills: {
    project: (root) => path.join(root, ".kilocode", "skills"),
  },
  mcp: {
    user: (ctx) => path.join(ctx.homeDir, ".config", "kilo", "kilo.jsonc"),
    project: (ctx) => path.join(ctx.projectRoot, "kilo.jsonc"),
    format: "yaml",
    topKey: ["mcp"],
    serverValue: kiloServerValue,
    parseServer: parseKiloServer,
  },
  instructions: {
    projectFile: "AGENTS.md",
    directoryFile: (dir) => `${dir}/AGENTS.md`,
  },
  hooks: { support: "unsupported" },
});
