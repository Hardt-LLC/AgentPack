import path from "node:path";

import type { CanonicalInstruction, CanonicalSkill } from "@agentpack/schema";
import { describe, expect, it } from "vitest";

import { generateKimi } from "../src/generate.js";
import { planKimiInstall } from "../src/plan.js";
import { makeContext, makeInstallContext, makePack, makeTmpDir } from "./helpers.js";

const skill: CanonicalSkill = {
  name: "review",
  description: "Review code",
  rootDir: "/packs/test/skills/review",
  files: ["SKILL.md"],
  frontmatter: { name: "review" },
};

const projectInstruction: CanonicalInstruction = {
  id: "coding-style",
  sourcePath: "/packs/test/instructions/coding-style.md",
  content: "Use strict TypeScript.",
  scope: "project",
  priority: 100,
  mergeStrategy: "managed-section",
};

const directoryInstruction: CanonicalInstruction = {
  id: "api-rules",
  sourcePath: "/packs/test/instructions/api-rules.md",
  content: "Validate all inputs.",
  scope: "directory",
  directory: "src/api",
  priority: 100,
  mergeStrategy: "managed-section",
};

const globalInstruction: CanonicalInstruction = {
  id: "global-tone",
  sourcePath: "/packs/test/instructions/global-tone.md",
  content: "Be concise.",
  scope: "global",
  priority: 100,
  mergeStrategy: "managed-section",
};

function packWith(tmp: string) {
  return makePack(path.join(tmp, "pack"), {
    skills: [skill],
    instructions: [projectInstruction, directoryInstruction, globalInstruction],
  });
}

function skillDest(ops: Awaited<ReturnType<typeof planKimiInstall>>): string {
  const copy = ops.find((o) => o.type === "copyDirectory");
  if (copy?.type === "copyDirectory") return copy.dest;
  const link = ops.find((o) => o.type === "createSymlink");
  if (link?.type === "createSymlink") return link.path;
  throw new Error("no skill install op");
}

function markdownPaths(ops: Awaited<ReturnType<typeof planKimiInstall>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const op of ops) {
    if (op.type === "managedMarkdownSection") out[op.sectionId] = op.path;
  }
  return out;
}

describe("path strategy", () => {
  it("shared strategy: project skills and AGENTS.md in shared agent dirs", async () => {
    const tmp = await makeTmpDir();
    const context = makeInstallContext(tmp, { options: { pathStrategy: "shared" } });
    const artifacts = await generateKimi(packWith(tmp), makeContext(tmp, context));
    const ops = await planKimiInstall(artifacts, context);

    expect(skillDest(ops)).toBe(path.join(tmp, "project", ".agents", "skills", "review"));
    const markdown = markdownPaths(ops);
    expect(markdown["coding-style"]).toBe(path.join(tmp, "project", "AGENTS.md"));
    expect(markdown["api-rules"]).toBe(path.join(tmp, "project", "src", "api", "AGENTS.md"));
    // Global instructions live in $KIMI_CODE_HOME under both strategies.
    expect(markdown["global-tone"]).toBe(path.join(tmp, "home", ".kimi-code", "AGENTS.md"));
  });

  it("shared strategy: user skills in <homeDir>/.agents/skills", async () => {
    const tmp = await makeTmpDir();
    const context = makeInstallContext(tmp, {
      scope: "user",
      options: { pathStrategy: "shared" },
    });
    const artifacts = await generateKimi(packWith(tmp), makeContext(tmp, context));
    const ops = await planKimiInstall(artifacts, context);

    expect(skillDest(ops)).toBe(path.join(tmp, "home", ".agents", "skills", "review"));
  });

  it("kimi strategy: everything under .kimi-code / $KIMI_CODE_HOME", async () => {
    const tmp = await makeTmpDir();
    const context = makeInstallContext(tmp, { options: { pathStrategy: "kimi" } });
    const artifacts = await generateKimi(packWith(tmp), makeContext(tmp, context));
    const ops = await planKimiInstall(artifacts, context);

    expect(skillDest(ops)).toBe(path.join(tmp, "project", ".kimi-code", "skills", "review"));
    const markdown = markdownPaths(ops);
    expect(markdown["coding-style"]).toBe(path.join(tmp, "project", ".kimi-code", "AGENTS.md"));
    expect(markdown["api-rules"]).toBe(
      path.join(tmp, "project", "src", "api", ".kimi-code", "AGENTS.md"),
    );
    expect(markdown["global-tone"]).toBe(path.join(tmp, "home", ".kimi-code", "AGENTS.md"));
  });

  it("kimi strategy: user skills in $KIMI_CODE_HOME/skills, honoring the env override", async () => {
    const tmp = await makeTmpDir();
    const context = makeInstallContext(tmp, {
      scope: "user",
      env: { KIMI_CODE_HOME: path.join(tmp, "kimi-home") },
      options: { pathStrategy: "kimi" },
    });
    const artifacts = await generateKimi(packWith(tmp), makeContext(tmp, context));
    const ops = await planKimiInstall(artifacts, context);

    expect(skillDest(ops)).toBe(path.join(tmp, "kimi-home", "skills", "review"));
  });

  it("defaults to the shared strategy when no option is given", async () => {
    const tmp = await makeTmpDir();
    const context = makeInstallContext(tmp);
    const artifacts = await generateKimi(packWith(tmp), makeContext(tmp));
    const ops = await planKimiInstall(artifacts, context);

    expect(skillDest(ops)).toBe(path.join(tmp, "project", ".agents", "skills", "review"));
  });
});
