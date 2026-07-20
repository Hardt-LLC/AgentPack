import { describe, expect, it } from "vitest";
import type { CapabilityFinding } from "@agentpack/schema";

import { createClaudeAdapter } from "../src/index.js";
import { makeAdapterContext, makePack, makeTmpDir } from "./helpers.js";

function findingsFor(
  findings: CapabilityFinding[],
  componentType: string,
  componentId: string,
): CapabilityFinding[] {
  return findings.filter((f) => f.componentType === componentType && f.componentId === componentId);
}

describe("analyze", () => {
  it("classifies components and reports degraded MCP policies", async () => {
    const tmp = await makeTmpDir();
    const adapter = createClaudeAdapter();
    const pack = makePack({
      skills: [
        {
          name: "security-review",
          description: "Reviews security",
          rootDir: "/packs/test-pack/skills/security-review",
          files: ["SKILL.md"],
          frontmatter: { name: "security-review" },
        },
      ],
      mcpServers: {
        github: {
          name: "github",
          transport: "stdio",
          command: "npx",
          enabled: true,
          passEnv: ["GH_TOKEN"],
          approval: { default: "always" },
          allowTools: ["get_issue"],
        },
        docs: { name: "docs", transport: "http", url: "https://example.com/mcp", enabled: true },
        off: { name: "off", transport: "stdio", command: "off", enabled: false },
      },
      instructions: [
        {
          id: "style",
          sourcePath: "/packs/test-pack/instructions/style.md",
          content: "Use spaces.",
          scope: "project",
          priority: 100,
          mergeStrategy: "managed-section",
          targets: ["claude"],
        },
        {
          id: "kimi-only",
          sourcePath: "/packs/test-pack/instructions/kimi.md",
          content: "Kimi only.",
          scope: "project",
          priority: 100,
          mergeStrategy: "managed-section",
          targets: ["kimi"],
        },
      ],
      plugin: { enabled: true },
      hooks: [
        { id: "lint", event: "preToolUse", matcher: "shell", command: ["npm", "run", "lint"] },
        { id: "notify", event: "notification", command: ["say", "done"] },
        { id: "codex-only", event: "sessionStart", command: ["true"], targets: ["codex"] },
      ],
      targetExtensions: {
        claude: { agents: [{ name: "reviewer", description: "Reviews code", content: "Review." }] },
      },
    });

    const report = await adapter.analyze(pack, makeAdapterContext(tmp, "project"));

    expect(findingsFor(report.findings, "skill", "security-review")).toEqual([
      expect.objectContaining({ support: "native", target: "claude" }),
    ]);

    const github = findingsFor(report.findings, "mcp", "github");
    expect(github.filter((f) => f.support === "native")).toHaveLength(1);
    const degraded = github.filter((f) => f.support === "degraded");
    expect(degraded).toHaveLength(3);
    const passEnv = degraded.find((f) => f.message?.includes("passEnv"));
    expect(passEnv?.remediation).toContain("fromEnv");
    expect(degraded.some((f) => f.message?.includes("approval"))).toBe(true);
    expect(degraded.some((f) => f.message?.includes("allowTools"))).toBe(true);

    expect(findingsFor(report.findings, "mcp", "docs")).toEqual([
      expect.objectContaining({ support: "native" }),
    ]);
    // Disabled servers are skipped entirely.
    expect(findingsFor(report.findings, "mcp", "off")).toHaveLength(0);

    expect(findingsFor(report.findings, "instruction", "style")).toEqual([
      expect.objectContaining({ support: "native" }),
    ]);
    // Instructions targeting other agents only are skipped.
    expect(findingsFor(report.findings, "instruction", "kimi-only")).toHaveLength(0);

    expect(findingsFor(report.findings, "plugin", "test-pack")).toEqual([
      expect.objectContaining({ support: "native" }),
    ]);

    expect(findingsFor(report.findings, "hook", "lint")).toEqual([
      expect.objectContaining({
        support: "transpiled",
        message: "Matcher normalized to Claude tool names",
      }),
    ]);
    expect(findingsFor(report.findings, "hook", "notify")).toEqual([
      expect.objectContaining({ support: "native" }),
    ]);
    expect(findingsFor(report.findings, "hook", "codex-only")).toHaveLength(0);

    expect(findingsFor(report.findings, "agent", "reviewer")).toEqual([
      expect.objectContaining({ support: "native" }),
    ]);
  });
});
