import { promises as fs } from "node:fs";
import path from "node:path";

import type { AdapterContext, CanonicalPack, GeneratedArtifact } from "@agentpack/schema";

import { buildHookEntry, groupHooksByEvent } from "./hooks.js";
import { buildMcpServerValue } from "./mcp.js";
import { targetsKimi } from "./util.js";

/** True when a directory exists and contains at least one file (recursively). */
async function dirHasFiles(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await dirHasFiles(path.join(dir, entry.name)))) return true;
  }
  return false;
}

/** Generate native artifacts (pure data, no filesystem writes). */
export async function generateKimi(
  pack: CanonicalPack,
  context: AdapterContext,
): Promise<GeneratedArtifact[]> {
  if (context.options.bundle === true) return generateBundle(pack);

  const root = context.scope === "project" ? "projectConfig" : "userConfig";
  const artifacts: GeneratedArtifact[] = [];

  for (const skill of pack.skills) {
    artifacts.push({
      kind: "skill",
      root,
      name: skill.name,
      sourceDir: skill.rootDir,
      relPath: `skills/${skill.name}`,
    });
  }

  for (const server of Object.values(pack.mcpServers)) {
    if (server.enabled === false) continue;
    artifacts.push({
      kind: "json-merge",
      root,
      relPath: "mcp.json",
      pointer: `/mcpServers/${server.name}`,
      value: buildMcpServerValue(server),
    });
  }

  for (const instruction of pack.instructions) {
    if (!targetsKimi(instruction.targets)) continue;
    const relPath =
      instruction.scope === "directory" && instruction.directory
        ? `${instruction.directory}/AGENTS.md`
        : "AGENTS.md";
    artifacts.push({
      kind: "markdown-section",
      root: instruction.scope === "global" ? "userConfig" : "projectConfig",
      relPath,
      sectionId: instruction.id,
      content: instruction.content,
      append: instruction.mergeStrategy === "append" ? true : undefined,
    });
  }

  const eligibleHooks = pack.hooks.filter((hook) => targetsKimi(hook.targets));
  for (const [event, hooks] of groupHooksByEvent(eligibleHooks)) {
    artifacts.push({
      kind: "json-merge",
      root,
      relPath: "hooks.json",
      pointer: `/hooks/${event}`,
      value: hooks.map(buildHookEntry),
    });
  }

  return artifacts;
}

/** Generate the `agentpack build` plugin bundle layout. */
async function generateBundle(pack: CanonicalPack): Promise<GeneratedArtifact[]> {
  const artifacts: GeneratedArtifact[] = [];

  const hookGroups = groupHooksByEvent(pack.hooks.filter((hook) => targetsKimi(hook.targets)));
  const servers = Object.values(pack.mcpServers).filter((server) => server.enabled !== false);
  const assetsDir = path.join(pack.rootDir, "assets");
  const hasAssets = await dirHasFiles(assetsDir);

  const manifest: Record<string, unknown> = {
    name: pack.metadata.name,
    version: pack.metadata.version,
  };
  if (pack.metadata.description) manifest.description = pack.metadata.description;
  if (pack.plugin?.interface) manifest.interface = pack.plugin.interface;
  manifest.skills = pack.skills.map((skill) => `skills/${skill.name}`);
  if (hookGroups.size > 0) manifest.hooks = "./hooks";
  if (servers.length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const server of servers) mcpServers[server.name] = buildMcpServerValue(server);
    manifest.mcpServers = mcpServers;
  }
  if (hasAssets) manifest.assets = "./assets";

  artifacts.push({
    kind: "file",
    root: "bundle",
    relPath: "kimi.plugin.json",
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  for (const skill of pack.skills) {
    artifacts.push({
      kind: "skill",
      root: "bundle",
      name: skill.name,
      sourceDir: skill.rootDir,
      relPath: `skills/${skill.name}`,
    });
  }

  if (hookGroups.size > 0) {
    const hooks: Record<string, unknown> = {};
    for (const [event, list] of hookGroups) hooks[event] = list.map(buildHookEntry);
    artifacts.push({
      kind: "file",
      root: "bundle",
      relPath: "hooks/hooks.json",
      content: `${JSON.stringify({ hooks }, null, 2)}\n`,
    });
  }

  if (hasAssets) {
    artifacts.push({
      kind: "skill",
      root: "bundle",
      name: "assets",
      sourceDir: assetsDir,
      relPath: "assets",
    });
  }

  return artifacts;
}
