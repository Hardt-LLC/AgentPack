import path from "node:path";

import type { GeneratedArtifact, InstallContext, InstallOperationLike } from "@agentpack/schema";

import {
  configBaseDir,
  markdownDestPath,
  resolvePathStrategy,
  skillBaseDir,
  type PathContext,
} from "./paths.js";

/**
 * Convert artifacts into installer operations with absolute paths. The path
 * strategy and install mode are read from the install context; artifacts
 * themselves carry no path decisions besides their logical root tag.
 */
export async function planKimiInstall(
  artifacts: GeneratedArtifact[],
  context: InstallContext,
): Promise<InstallOperationLike[]> {
  const strategy = resolvePathStrategy(context.options);
  const useSymlink =
    context.installMode === "symlink" ||
    (context.installMode === "auto" && context.symlinksReliable);
  const ctx: PathContext = {
    projectRoot: context.projectRoot,
    homeDir: context.homeDir,
    env: context.env,
  };

  const ops: InstallOperationLike[] = [];
  for (const artifact of artifacts) {
    if (artifact.root === "bundle") {
      if (!context.bundleRoot) {
        throw new Error("kimi adapter: bundle artifacts require context.bundleRoot");
      }
      const dest = path.join(context.bundleRoot, ...artifact.relPath.split("/"));
      switch (artifact.kind) {
        case "file":
          ops.push({
            type: "writeFile",
            path: dest,
            content: artifact.content,
            executable: artifact.executable,
          });
          break;
        case "skill":
          ops.push({ type: "copyDirectory", source: artifact.sourceDir, dest });
          break;
        case "json-merge":
          ops.push({
            type: "mergeJson",
            path: dest,
            pointer: artifact.pointer,
            value: artifact.value,
          });
          break;
        case "markdown-section":
          ops.push({
            type: "managedMarkdownSection",
            path: dest,
            sectionId: artifact.sectionId,
            content: artifact.content,
            append: artifact.append,
          });
          break;
        case "toml-merge":
          throw new Error("kimi adapter does not emit toml-merge artifacts");
      }
      continue;
    }

    const root = artifact.root;
    switch (artifact.kind) {
      case "skill": {
        const dest = path.join(skillBaseDir(strategy, root, ctx), artifact.name);
        ops.push(
          useSymlink
            ? { type: "createSymlink", path: dest, target: artifact.sourceDir }
            : { type: "copyDirectory", source: artifact.sourceDir, dest },
        );
        break;
      }
      case "json-merge": {
        const file = path.join(configBaseDir(root, ctx), ...artifact.relPath.split("/"));
        ops.push({
          type: "mergeJson",
          path: file,
          pointer: artifact.pointer,
          value: artifact.value,
        });
        break;
      }
      case "markdown-section": {
        const file = markdownDestPath(strategy, root, artifact.relPath, ctx);
        ops.push({
          type: "managedMarkdownSection",
          path: file,
          sectionId: artifact.sectionId,
          content: artifact.content,
          append: artifact.append,
        });
        break;
      }
      case "file": {
        const file = path.join(configBaseDir(root, ctx), ...artifact.relPath.split("/"));
        ops.push({
          type: "writeFile",
          path: file,
          content: artifact.content,
          executable: artifact.executable,
        });
        break;
      }
      case "toml-merge":
        throw new Error("kimi adapter does not emit toml-merge artifacts");
    }
  }
  return ops;
}
