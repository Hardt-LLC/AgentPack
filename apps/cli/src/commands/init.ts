import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { CliError } from "../errors.js";
import { out } from "../output.js";

const WORKSPACE_YAML = `apiVersion: agentpack.dev/v1alpha1
kind: Workspace

packs:
  - path: ./packs/example

profiles:
  default:
    packs:
      - example
    targets:
      - codex
      - claude
      - kimi
    scope: project
    installMode: auto
`;

const PACK_YAML = `apiVersion: agentpack.dev/v1alpha1
kind: Pack

metadata:
  name: example
  version: 0.1.0
  description: Example pack created by agentpack init

spec:
  skills:
    - path: ./skills/example

  instructions:
    - id: example-notes
      path: ./instructions/example.md
      scope: project
      priority: 100

  plugin:
    enabled: true
    interface:
      displayName: Example
      shortDescription: Example pack created by agentpack init
`;

const SKILL_MD = `---
name: example
description: Example skill created by agentpack init.
---

# Example

Replace this file with your own skill instructions.
`;

const INSTRUCTION_MD = `# Example notes

Project-level instructions managed by AgentPack. Edit this file and run
\`agentpack sync\` to push it into every target's native config.
`;

const GITIGNORE = `.agentpack/generated/
.agentpack/backups/
.agentpack/state.json
dist/
`;

const README_MD = `# AgentPack workspace

This workspace is managed by AgentPack (see \`agentpack.yaml\`): canonical
packs under \`packs/\` are compiled and synced into native config for codex,
claude and kimi.

- \`agentpack validate\` — check the workspace
- \`agentpack plan\` — preview what a sync would change
- \`agentpack sync\` — write native config (backs up first, conflict-aware)
- \`agentpack build\` — emit plugin bundles into \`dist/\`
`;

export function registerInit(program: Command): void {
  program
    .command("init [dir]")
    .description("create a new AgentPack workspace (default: current directory)")
    .action(async (dir?: string) => {
      const root = path.resolve(dir ?? process.cwd());
      if (await exists(path.join(root, "agentpack.yaml"))) {
        throw new CliError(`agentpack.yaml already exists in ${root}`, 2);
      }

      const files: Record<string, string> = {
        "agentpack.yaml": WORKSPACE_YAML,
        "packs/example/pack.yaml": PACK_YAML,
        "packs/example/skills/example/SKILL.md": SKILL_MD,
        "packs/example/instructions/example.md": INSTRUCTION_MD,
        ".gitignore": GITIGNORE,
        "README.md": README_MD,
      };

      await fs.mkdir(root, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const dest = path.join(root, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, "utf8");
      }

      out(`Created AgentPack workspace in ${root}:`);
      for (const rel of Object.keys(files)) out(`  - ${rel}`);
      out("");
      out("Next: run `agentpack validate`, then `agentpack sync`.");
    });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
