import path from "node:path";

import { pathExists } from "@agentpack/filesystem";
import type {
  ArtifactRoot,
  GeneratedArtifact,
  InstallContext,
  InstallOperationLike,
} from "@agentpack/schema";

function resolveBase(root: ArtifactRoot, context: InstallContext): string {
  switch (root) {
    case "projectConfig":
      return context.detection.projectConfigRoot || path.join(context.projectRoot, ".claude");
    case "userConfig":
      return context.detection.userConfigRoot || path.join(context.homeDir, ".claude");
    case "bundle":
      if (!context.bundleRoot) {
        throw new Error('bundle artifacts require InstallContext.bundleRoot ("agentpack build")');
      }
      return context.bundleRoot;
  }
}

function useSymlink(context: InstallContext): boolean {
  return (
    context.installMode === "symlink" ||
    (context.installMode === "auto" && context.symlinksReliable)
  );
}

/**
 * Convert generated artifacts into installer operations with absolute paths.
 * Bundle skills are always copied (a bundle must be self-contained); a bundle
 * skill whose source directory is absent (optional pack assets) is skipped.
 */
export async function planInstall(
  artifacts: GeneratedArtifact[],
  context: InstallContext,
): Promise<InstallOperationLike[]> {
  const operations: InstallOperationLike[] = [];

  for (const artifact of artifacts) {
    const base = resolveBase(artifact.root, context);
    const absolute = path.resolve(base, artifact.relPath);

    switch (artifact.kind) {
      case "file":
        operations.push({
          type: "writeFile",
          path: absolute,
          content: artifact.content,
          executable: artifact.executable,
        });
        break;
      case "skill":
        if (artifact.root === "bundle") {
          if (await pathExists(artifact.sourceDir)) {
            operations.push({ type: "copyDirectory", source: artifact.sourceDir, dest: absolute });
          }
        } else if (useSymlink(context)) {
          operations.push({ type: "createSymlink", path: absolute, target: artifact.sourceDir });
        } else {
          operations.push({ type: "copyDirectory", source: artifact.sourceDir, dest: absolute });
        }
        break;
      case "json-merge":
        operations.push({
          type: "mergeJson",
          path: absolute,
          pointer: artifact.pointer,
          value: artifact.value,
        });
        break;
      case "toml-merge":
        operations.push({
          type: "mergeToml",
          path: absolute,
          table: artifact.table,
          value: artifact.value,
        });
        break;
      case "markdown-section":
        operations.push({
          type: "managedMarkdownSection",
          path: absolute,
          sectionId: artifact.sectionId,
          content: artifact.content,
          append: artifact.append,
        });
        break;
    }
  }

  return operations;
}
