import path from "node:path";

import type { CanonicalInstruction, Scope } from "@agentpack/schema";
import type { ArtifactRoot } from "@agentpack/schema";

/**
 * Claude Code config layout:
 * - project scope: <projectRoot>/.claude (config root) plus <projectRoot>/.mcp.json
 *   and <projectRoot>/CLAUDE.md at the project root.
 * - user scope: <homeDir>/.claude (config root) plus <homeDir>/.claude.json and
 *   <homeDir>/.claude/CLAUDE.md.
 *
 * Artifact relPaths are resolved against the config root, so files living next
 * to it use ".." segments (e.g. "../.mcp.json").
 */

/** Artifact root holding skills / settings.json for a scope. */
export function configRootFor(scope: Scope): ArtifactRoot {
  return scope === "project" ? "projectConfig" : "userConfig";
}

export function skillRelPath(name: string): string {
  return `skills/${name}`;
}

/** MCP server definitions file, relative to the scope's config root. */
export function mcpConfigRelPath(scope: Scope): string {
  return scope === "project" ? "../.mcp.json" : "../.claude.json";
}

/** Claude Code settings file (hooks), relative to the scope's config root. */
export const SETTINGS_REL_PATH = "settings.json";

/** Where an instruction's managed section lives. */
export function instructionLocation(instruction: CanonicalInstruction): {
  root: ArtifactRoot;
  relPath: string;
} {
  switch (instruction.scope) {
    case "global":
      return { root: "userConfig", relPath: "CLAUDE.md" };
    case "project":
      return { root: "projectConfig", relPath: "../CLAUDE.md" };
    case "directory": {
      const directory = (instruction.directory ?? "").replace(/\\/g, "/");
      return { root: "projectConfig", relPath: `../${directory}/CLAUDE.md` };
    }
  }
}

/** Absolute paths of the files the importer reads, per scope. */
export function nativeImportPaths(
  scope: Scope,
  projectRoot: string,
  homeDir: string,
): { mcpFile: string; claudeMd: string; skillsDir: string; settingsFile: string } {
  if (scope === "project") {
    return {
      mcpFile: path.join(projectRoot, ".mcp.json"),
      claudeMd: path.join(projectRoot, "CLAUDE.md"),
      skillsDir: path.join(projectRoot, ".claude", "skills"),
      settingsFile: path.join(projectRoot, ".claude", "settings.json"),
    };
  }
  return {
    mcpFile: path.join(homeDir, ".claude.json"),
    claudeMd: path.join(homeDir, ".claude", "CLAUDE.md"),
    skillsDir: path.join(homeDir, ".claude", "skills"),
    settingsFile: path.join(homeDir, ".claude", "settings.json"),
  };
}
