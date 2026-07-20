import path from "node:path";

import type { CanonicalHook, CanonicalMcpServer, CanonicalSkill } from "@agentpack/schema";
import { describe, expect, it } from "vitest";

import { analyzeKimi } from "../src/analyze.js";
import { makeContext, makePack, makeTmpDir } from "./helpers.js";

const hooks: CanonicalHook[] = [
  { id: "lint", event: "preToolUse", matcher: "shell", command: ["pnpm", "lint"] },
  { id: "notify", event: "notification", command: ["say", "done"] },
];

describe("analyzeKimi", () => {
  it("classifies skills, mcp, instructions and plugins as native", async () => {
    const tmp = await makeTmpDir();
    const skill: CanonicalSkill = {
      name: "review",
      description: "",
      rootDir: "/x",
      files: ["SKILL.md"],
      frontmatter: {},
    };
    const server: CanonicalMcpServer = {
      name: "github",
      transport: "stdio",
      command: "npx",
      enabled: true,
    };
    const pack = makePack(path.join(tmp, "pack"), {
      skills: [skill],
      mcpServers: { github: server },
      instructions: [
        {
          id: "style",
          sourcePath: "/x/style.md",
          content: "hi",
          scope: "project",
          priority: 100,
          mergeStrategy: "managed-section",
        },
      ],
      plugin: { enabled: true },
    });

    const report = await analyzeKimi(pack, makeContext(tmp));
    const byId = new Map(report.findings.map((f) => [`${f.componentType}:${f.componentId}`, f]));

    expect(byId.get("skill:review")?.support).toBe("native");
    expect(byId.get("mcp:github")?.support).toBe("native");
    expect(byId.get("instruction:style")?.support).toBe("native");
    expect(byId.get("plugin:test-pack")?.support).toBe("native");
  });

  it("marks hooks as transpiled and notification as unsupported", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), { hooks });

    const report = await analyzeKimi(pack, makeContext(tmp));
    const byId = new Map(report.findings.map((f) => [f.componentId, f]));

    expect(byId.get("lint")?.support).toBe("transpiled");
    expect(byId.get("lint")?.message).toBe("rendered to kimi hooks.json");
    expect(byId.get("notify")?.support).toBe("unsupported");
    expect(byId.get("notify")?.remediation).toContain("sessionEnd");
  });

  it("skips disabled mcp servers entirely", async () => {
    const tmp = await makeTmpDir();
    const server: CanonicalMcpServer = {
      name: "off",
      transport: "stdio",
      command: "npx",
      enabled: false,
    };
    const pack = makePack(path.join(tmp, "pack"), { mcpServers: { off: server } });

    const report = await analyzeKimi(pack, makeContext(tmp));
    expect(report.findings).toEqual([]);
  });

  it("skips hooks and instructions targeting other agents", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      hooks: [{ id: "claude-only", event: "sessionStart", command: ["x"], targets: ["claude"] }],
      instructions: [
        {
          id: "codex-only",
          sourcePath: "/x.md",
          content: "x",
          scope: "project",
          priority: 100,
          mergeStrategy: "managed-section",
          targets: ["codex"],
        },
      ],
    });

    const report = await analyzeKimi(pack, makeContext(tmp));
    expect(report.findings).toEqual([]);
  });
});
