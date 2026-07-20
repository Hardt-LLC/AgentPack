import { describe, expect, it } from "vitest";

import { createCodexAdapter } from "../src/index.js";
import { makeContext, makeInstruction, makePack, makeSkill, makeStdioServer } from "./helpers.js";

describe("analyze", () => {
  const adapter = createCodexAdapter();
  const context = makeContext();

  it("classifies every skill as native", async () => {
    const pack = makePack({ skills: [makeSkill("review"), makeSkill("lint")] });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([
      { target: "codex", componentType: "skill", componentId: "review", support: "native" },
      { target: "codex", componentType: "skill", componentId: "lint", support: "native" },
    ]);
  });

  it("classifies stdio servers as native", async () => {
    const pack = makePack({ mcpServers: { github: makeStdioServer("github") } });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([
      { target: "codex", componentType: "mcp", componentId: "github", support: "native" },
    ]);
  });

  it("classifies http servers as transpiled", async () => {
    const pack = makePack({
      mcpServers: {
        docs: { ...makeStdioServer("docs"), transport: "http", url: "https://x.test/mcp" },
      },
    });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([
      {
        target: "codex",
        componentType: "mcp",
        componentId: "docs",
        support: "transpiled",
        message: "rendered to config.toml mcp_servers",
      },
    ]);
  });

  it("classifies sse servers as degraded", async () => {
    const pack = makePack({
      mcpServers: {
        legacy: { ...makeStdioServer("legacy"), transport: "sse", url: "https://x.test/sse" },
      },
    });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([
      {
        target: "codex",
        componentType: "mcp",
        componentId: "legacy",
        support: "degraded",
        message: "Codex has deprecated the sse transport",
        remediation: "use the http transport instead",
      },
    ]);
  });

  it("adds a degraded finding when allowTools or denyTools are set", async () => {
    const pack = makePack({
      mcpServers: { github: makeStdioServer("github", { allowTools: ["read"], denyTools: [] }) },
    });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[1]).toEqual({
      target: "codex",
      componentType: "mcp",
      componentId: "github",
      support: "degraded",
      message: "allowTools/denyTools have no Codex config.toml equivalent and are not rendered",
      remediation: "rely on the native agent's approval system",
    });
  });

  it("skips disabled servers entirely", async () => {
    const pack = makePack({
      mcpServers: { github: makeStdioServer("github", { enabled: false }) },
    });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([]);
  });

  it("classifies instructions and enabled plugins as native", async () => {
    const pack = makePack({
      instructions: [makeInstruction()],
      plugin: { enabled: true },
    });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([
      { target: "codex", componentType: "instruction", componentId: "rules", support: "native" },
      { target: "codex", componentType: "plugin", componentId: "test-pack", support: "native" },
    ]);
  });

  it("emits no plugin finding when the plugin is disabled", async () => {
    const pack = makePack({ plugin: { enabled: false } });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([]);
  });

  it("classifies every hook as unsupported", async () => {
    const pack = makePack({
      hooks: [{ id: "check", event: "preToolUse", command: ["npm", "test"] }],
    });
    const report = await adapter.analyze(pack, context);
    expect(report.findings).toEqual([
      {
        target: "codex",
        componentType: "hook",
        componentId: "check",
        support: "unsupported",
        message: "Codex has no hook system",
        remediation:
          "use a skill or CI check instead; the hook is still exported into the plugin bundle",
      },
    ]);
  });
});
