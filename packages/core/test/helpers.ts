import path from "node:path";
import type {
  AdapterContext,
  CanonicalPack,
  CapabilityReport,
  DetectionContext,
  GeneratedArtifact,
  InstallContext,
  InstallOperationLike,
  TargetAdapter,
  TargetDetection,
} from "@agentpack/schema";
import { writeTree } from "@agentpack/testing";

/** A deterministic in-memory adapter used to test the core engine. */
export function createFakeAdapter(id: "codex" | "claude" | "kimi" = "claude"): TargetAdapter {
  return {
    id,
    async detect(context: DetectionContext): Promise<TargetDetection> {
      return {
        installed: true,
        executablePath: `/fake/bin/${id}`,
        version: "1.0.0",
        userConfigRoot: path.join(context.homeDir, `.${id}`),
        projectConfigRoot: path.join(context.projectRoot, `.${id}`),
        warnings: [],
      };
    },
    async analyze(pack: CanonicalPack, _context: AdapterContext): Promise<CapabilityReport> {
      const findings: CapabilityReport["findings"] = [];
      for (const skill of pack.skills) {
        findings.push({
          target: id,
          componentType: "skill",
          componentId: skill.name,
          support: "native",
        });
      }
      for (const name of Object.keys(pack.mcpServers)) {
        findings.push({ target: id, componentType: "mcp", componentId: name, support: "native" });
      }
      for (const instruction of pack.instructions) {
        findings.push({
          target: id,
          componentType: "instruction",
          componentId: instruction.id,
          support: "native",
        });
      }
      for (const hook of pack.hooks) {
        findings.push({
          target: id,
          componentType: "hook",
          componentId: hook.id,
          support: id === "codex" ? "unsupported" : "native",
          message: id === "codex" ? "codex has no hooks" : undefined,
        });
      }
      return { findings };
    },
    async generate(pack: CanonicalPack, context: AdapterContext): Promise<GeneratedArtifact[]> {
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
      for (const [name, server] of Object.entries(pack.mcpServers)) {
        if (server.enabled === false) continue;
        artifacts.push({
          kind: "json-merge",
          root,
          relPath: "mcp.json",
          pointer: `/mcpServers/${name}`,
          value: {
            transport: server.transport,
            command: server.command,
            args: server.args,
            url: server.url,
          },
        });
      }
      for (const instruction of pack.instructions) {
        if (instruction.targets && !instruction.targets.includes(id)) continue;
        artifacts.push({
          kind: "markdown-section",
          root,
          relPath: "INSTRUCTIONS.md",
          sectionId: instruction.id,
          content: instruction.content,
        });
      }
      return artifacts;
    },
    async planInstall(
      artifacts: GeneratedArtifact[],
      context: InstallContext,
    ): Promise<InstallOperationLike[]> {
      const base =
        context.bundleRoot ??
        (context.scope === "project"
          ? path.join(context.projectRoot, `.${id}`)
          : path.join(context.homeDir, `.${id}`));
      const ops: InstallOperationLike[] = [];
      for (const artifact of artifacts) {
        if (artifact.kind === "skill") {
          const dest = path.join(base, artifact.relPath);
          if (context.installMode === "copy" || !context.symlinksReliable) {
            ops.push({ type: "copyDirectory", source: artifact.sourceDir, dest });
          } else {
            ops.push({ type: "createSymlink", path: dest, target: artifact.sourceDir });
          }
        } else if (artifact.kind === "file") {
          ops.push({
            type: "writeFile",
            path: path.join(base, artifact.relPath),
            content: artifact.content,
          });
        } else if (artifact.kind === "json-merge") {
          ops.push({
            type: "mergeJson",
            path: path.join(base, artifact.relPath),
            pointer: artifact.pointer,
            value: artifact.value,
          });
        } else if (artifact.kind === "toml-merge") {
          ops.push({
            type: "mergeToml",
            path: path.join(base, artifact.relPath),
            table: artifact.table,
            value: artifact.value,
          });
        } else if (artifact.kind === "markdown-section") {
          ops.push({
            type: "managedMarkdownSection",
            path: path.join(base, artifact.relPath),
            sectionId: artifact.sectionId,
            content: artifact.content,
            append: artifact.append,
          });
        }
      }
      return ops;
    },
  };
}

/** A standard two-pack workspace fixture (pack "tools" with skill+mcp+instruction). */
export const WORKSPACE_FILES: Record<string, string> = {
  "agentpack.yaml": `apiVersion: agentpack.dev/v1alpha1
kind: Workspace
packs:
  - path: ./packs/tools
profiles:
  default:
    packs: [tools]
    targets: [claude]
    scope: project
    installMode: auto
`,
  "packs/tools/pack.yaml": `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: tools
  version: 0.1.0
spec:
  skills:
    - path: ./skills/tools
  instructions:
    - id: baseline
      path: ./instructions/base.md
      scope: project
  mcpServers:
    local:
      transport: stdio
      command: node
      args: ["./server.mjs"]
`,
  "packs/tools/skills/tools/SKILL.md": `---
name: tools
description: test skill
---

# tools
`,
  "packs/tools/instructions/base.md": "## baseline rules\n",
};

export async function writeWorkspace(
  root: string,
  files: Record<string, string> = WORKSPACE_FILES,
): Promise<void> {
  await writeTree(root, files);
}
