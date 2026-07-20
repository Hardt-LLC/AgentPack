import path from "node:path";

import type {
  AdapterContext,
  CanonicalMcpServer,
  CanonicalPack,
  GeneratedArtifact,
} from "@agentpack/schema";

import { claudeAgentFileContent, readClaudeAgents } from "./agents.js";
import { groupHooksByEvent, targetsIncludeClaude } from "./hooks.js";
import { claudeMcpServerValue, mcpServerPointer } from "./mcp.js";
import {
  SETTINGS_REL_PATH,
  configRootFor,
  instructionLocation,
  mcpConfigRelPath,
  skillRelPath,
} from "./paths.js";

function enabledServers(pack: CanonicalPack): CanonicalMcpServer[] {
  return Object.values(pack.mcpServers).filter((server) => server.enabled !== false);
}

function claudeHooks(pack: CanonicalPack): CanonicalPack["hooks"] {
  return pack.hooks.filter((hook) => targetsIncludeClaude(hook.targets));
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Generate native Claude Code artifacts (pure data — no filesystem writes).
 * When context.options.bundle === true, a self-contained plugin bundle layout
 * is generated under the "bundle" root instead of config-root artifacts.
 */
export async function generate(
  pack: CanonicalPack,
  context: AdapterContext,
): Promise<GeneratedArtifact[]> {
  if (context.options.bundle === true) return generateBundle(pack);

  const artifacts: GeneratedArtifact[] = [];
  const root = configRootFor(context.scope);

  for (const skill of pack.skills) {
    artifacts.push({
      kind: "skill",
      root,
      name: skill.name,
      sourceDir: skill.rootDir,
      relPath: skillRelPath(skill.name),
    });
  }

  const mcpRelPath = mcpConfigRelPath(context.scope);
  for (const server of enabledServers(pack)) {
    artifacts.push({
      kind: "json-merge",
      root,
      relPath: mcpRelPath,
      pointer: mcpServerPointer(server.name),
      value: claudeMcpServerValue(server),
    });
  }

  for (const instruction of pack.instructions) {
    if (!targetsIncludeClaude(instruction.targets)) continue;
    const location = instructionLocation(instruction);
    artifacts.push({
      kind: "markdown-section",
      root: location.root,
      relPath: location.relPath,
      sectionId: instruction.id,
      content: instruction.content,
      append: instruction.mergeStrategy === "append" ? true : undefined,
    });
  }

  const grouped = groupHooksByEvent(claudeHooks(pack));
  for (const [event, entries] of Object.entries(grouped)) {
    artifacts.push({
      kind: "json-merge",
      root,
      relPath: SETTINGS_REL_PATH,
      pointer: `/hooks/${event}`,
      value: entries,
    });
  }

  return artifacts;
}

/**
 * Plugin bundle layout under the "bundle" root:
 * .claude-plugin/plugin.json, skills/, agents/, hooks/hooks.json, .mcp.json
 * and assets/ (the latter emitted unconditionally as a skill artifact;
 * planInstall stats the source and skips it when the pack has no assets).
 */
function generateBundle(pack: CanonicalPack): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];

  const manifest: Record<string, unknown> = {
    name: pack.metadata.name,
    version: pack.metadata.version,
  };
  if (pack.metadata.description) manifest.description = pack.metadata.description;
  const iface = pack.plugin?.interface;
  if (iface?.author) manifest.author = iface.author;
  if (iface?.displayName) manifest.displayName = iface.displayName;
  if (iface?.shortDescription) manifest.shortDescription = iface.shortDescription;
  artifacts.push({
    kind: "file",
    root: "bundle",
    relPath: ".claude-plugin/plugin.json",
    content: formatJson(manifest),
  });

  for (const skill of pack.skills) {
    artifacts.push({
      kind: "skill",
      root: "bundle",
      name: skill.name,
      sourceDir: skill.rootDir,
      relPath: skillRelPath(skill.name),
    });
  }

  for (const agent of readClaudeAgents(pack)) {
    artifacts.push({
      kind: "file",
      root: "bundle",
      relPath: `agents/${agent.name}.md`,
      content: claudeAgentFileContent(agent),
    });
  }

  const grouped = groupHooksByEvent(claudeHooks(pack));
  if (Object.keys(grouped).length > 0) {
    artifacts.push({
      kind: "file",
      root: "bundle",
      relPath: "hooks/hooks.json",
      content: formatJson({ hooks: grouped }),
    });
  }

  const servers = enabledServers(pack);
  if (servers.length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const server of servers) {
      mcpServers[server.name] = claudeMcpServerValue(server);
    }
    artifacts.push({
      kind: "file",
      root: "bundle",
      relPath: ".mcp.json",
      content: formatJson({ mcpServers }),
    });
  }

  // Optional pack assets; planInstall skips this when the directory is absent.
  artifacts.push({
    kind: "skill",
    root: "bundle",
    name: "assets",
    sourceDir: path.join(pack.rootDir, "assets"),
    relPath: "assets",
  });

  return artifacts;
}
