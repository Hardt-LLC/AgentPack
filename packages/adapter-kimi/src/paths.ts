import path from "node:path";

/** Where kimi-native files live: shared agent dirs vs $KIMI_CODE_HOME. */
export type PathStrategy = "shared" | "kimi";

/** Read the path strategy from adapter options (default "shared"). */
export function resolvePathStrategy(options: Record<string, unknown>): PathStrategy {
  return options.pathStrategy === "kimi" ? "kimi" : "shared";
}

/** Kimi Code home: $KIMI_CODE_HOME or ~/.kimi-code. */
export function resolveKimiHome(env: Record<string, string | undefined>, homeDir: string): string {
  const override = env.KIMI_CODE_HOME;
  return override && override.length > 0 ? override : path.join(homeDir, ".kimi-code");
}

/** The project-scope kimi config directory. */
export function projectConfigRoot(projectRoot: string): string {
  return path.join(projectRoot, ".kimi-code");
}

export interface PathContext {
  projectRoot: string;
  homeDir: string;
  env: Record<string, string | undefined>;
}

/** Directory that holds installed skill directories for a scope root. */
export function skillBaseDir(
  strategy: PathStrategy,
  root: "projectConfig" | "userConfig",
  ctx: PathContext,
): string {
  if (root === "projectConfig") {
    return strategy === "kimi"
      ? path.join(ctx.projectRoot, ".kimi-code", "skills")
      : path.join(ctx.projectRoot, ".agents", "skills");
  }
  return strategy === "kimi"
    ? path.join(resolveKimiHome(ctx.env, ctx.homeDir), "skills")
    : path.join(ctx.homeDir, ".agents", "skills");
}

/** Base directory for plain config files (mcp.json, hooks.json). */
export function configBaseDir(root: "projectConfig" | "userConfig", ctx: PathContext): string {
  return root === "projectConfig"
    ? projectConfigRoot(ctx.projectRoot)
    : resolveKimiHome(ctx.env, ctx.homeDir);
}

/**
 * Resolve a markdown artifact relPath ("AGENTS.md" or "<dir>/AGENTS.md") to an
 * absolute path. Global-scope files always live in $KIMI_CODE_HOME; project
 * files move under .kimi-code only with the "kimi" strategy.
 */
export function markdownDestPath(
  strategy: PathStrategy,
  root: "projectConfig" | "userConfig",
  relPath: string,
  ctx: PathContext,
): string {
  if (root === "userConfig") {
    return path.join(resolveKimiHome(ctx.env, ctx.homeDir), ...relPath.split("/"));
  }
  if (strategy === "shared") {
    return path.join(ctx.projectRoot, ...relPath.split("/"));
  }
  const segments = relPath.split("/");
  const file = segments[segments.length - 1]!;
  const dirs = segments.slice(0, -1);
  return path.join(ctx.projectRoot, ...dirs, ".kimi-code", file);
}
