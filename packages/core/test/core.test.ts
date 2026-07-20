import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, writeTree } from "@agentpack/testing";
import {
  buildPlan,
  createRegistry,
  detectTargets,
  diffWorkspace,
  evaluateTrust,
  findWorkspaceRoot,
  loadPack,
  loadSkill,
  loadWorkspace,
  parsePackManifest,
  parseWorkspaceManifest,
  removePack,
  resolveSelection,
  rollback,
  strictnessDiagnostics,
  syncWorkspace,
  trustRequirement,
  validateWorkspace,
} from "../src/index.js";
import { loadState } from "@agentpack/filesystem";
import { createFakeAdapter, writeWorkspace } from "./helpers.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
let home: { dir: string; cleanup: () => Promise<void> };

beforeEach(async () => {
  tmp = await makeTempDir();
  home = await makeTempDir("agentpack-home-");
});
afterEach(async () => {
  await tmp.cleanup();
  await home.cleanup();
});

const registry = () => createRegistry([createFakeAdapter("claude")]);
const detected = (root: string) => detectTargets(registry(), root, { homeDir: home.dir, env: {} });

describe("workspace loading", () => {
  it("finds the workspace root by walking up", async () => {
    await writeWorkspace(tmp.dir);
    const found = await findWorkspaceRoot(path.join(tmp.dir, "packs", "tools"));
    expect(found).toBe(tmp.dir);
  });

  it("loads a valid workspace with packs", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(ws.packs[0]?.pack?.metadata.name).toBe("tools");
    expect(ws.packs[0]?.pack?.skills[0]?.name).toBe("tools");
    expect(ws.packs[0]?.pack?.mcpServers["local"]?.transport).toBe("stdio");
    expect(ws.workspaceId).toMatch(/^sha256:/);
  });

  it("rejects unknown top-level fields in pack.yaml", async () => {
    const result = parsePackManifest(
      `apiVersion: agentpack.dev/v1alpha1\nkind: Pack\nmetadata:\n  name: x\n  version: 0.1.0\nbogus: true\nspec: {}\n`,
      "test",
    );
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  it("rejects unknown top-level fields in agentpack.yaml", async () => {
    const result = parseWorkspaceManifest(
      `apiVersion: agentpack.dev/v1alpha1\nkind: Workspace\nnope: 1\n`,
      "test",
    );
    expect(result.manifest).toBeUndefined();
  });

  it("errors when a pack directory does not exist", async () => {
    await writeTree(tmp.dir, {
      "agentpack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Workspace\npacks:\n  - path: ./packs/missing\n`,
    });
    const ws = await loadWorkspace(tmp.dir);
    expect(
      ws.diagnostics.some((d) => d.severity === "error" && d.message.includes("not found")),
    ).toBe(true);
  });

  it("reports duplicate pack names", async () => {
    await writeTree(tmp.dir, {
      "agentpack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Workspace\npacks:\n  - path: ./packs/a\n  - path: ./packs/b\n`,
      "packs/a/pack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Pack\nmetadata:\n  name: dup\n  version: 0.1.0\nspec: {}\n`,
      "packs/b/pack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Pack\nmetadata:\n  name: dup\n  version: 0.1.0\nspec: {}\n`,
    });
    const ws = await loadWorkspace(tmp.dir);
    expect(ws.diagnostics.some((d) => d.message.includes("duplicate pack name"))).toBe(true);
  });
});

describe("skill validation", () => {
  it("rejects a skill missing SKILL.md", async () => {
    await writeTree(tmp.dir, { "skills/x/notes.md": "hi" });
    const { diagnostics } = await loadSkill(path.join(tmp.dir, "skills", "x"));
    expect(diagnostics.some((d) => d.message.includes("SKILL.md"))).toBe(true);
  });

  it("rejects name/dir mismatch and bad characters", async () => {
    await writeTree(tmp.dir, {
      "skills/real/SKILL.md": `---\nname: other\ndescription: x\n---\n`,
    });
    const { diagnostics } = await loadSkill(path.join(tmp.dir, "skills", "real"));
    expect(diagnostics.some((d) => d.message.includes("does not match directory"))).toBe(true);

    await writeTree(tmp.dir, {
      "skills/Bad/SKILL.md": `---\nname: Bad\ndescription: x\n---\n`,
    });
    const { diagnostics: diags2 } = await loadSkill(path.join(tmp.dir, "skills", "Bad"));
    expect(diags2.some((d) => d.message.includes("lowercase"))).toBe(true);
  });

  it("rejects markdown links escaping the skill root", async () => {
    await writeTree(tmp.dir, {
      "skills/x/SKILL.md": `---\nname: x\ndescription: x\n---\n\n[evil](../../../etc/passwd)\n`,
    });
    const { diagnostics } = await loadSkill(path.join(tmp.dir, "skills", "x"));
    expect(diagnostics.some((d) => d.message.includes("escapes skill root"))).toBe(true);
  });

  it("accepts a valid skill with local references", async () => {
    await writeTree(tmp.dir, {
      "skills/x/SKILL.md": `---\nname: x\ndescription: x\n---\n\nSee [refs](references/r.md).\n`,
      "skills/x/references/r.md": "# ref\n",
    });
    const { skill, diagnostics } = await loadSkill(path.join(tmp.dir, "skills", "x"));
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(skill?.files).toContain("references/r.md");
  });
});

describe("profiles and validation", () => {
  it("resolves the default profile", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const selection = resolveSelection(ws, {}, ["claude"]);
    expect(selection.packs.map((p) => p.metadata.name)).toEqual(["tools"]);
    expect(selection.targets).toEqual(["claude"]);
    expect(selection.scope).toBe("project");
  });

  it("errors for unknown profiles", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const selection = resolveSelection(ws, { profile: "nope" }, ["claude"]);
    expect(selection.diagnostics.some((d) => d.message.includes("profile not found"))).toBe(true);
  });

  it("validates a good workspace end to end", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const result = await validateWorkspace(ws, registry(), await detected(tmp.dir), { env: {} });
    expect(result.ok).toBe(true);
    expect(result.capabilityReports.length).toBeGreaterThan(0);
  });

  it("reports missing env vars by name only", async () => {
    await writeWorkspace(tmp.dir, {
      "agentpack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Workspace\npacks:\n  - path: ./packs/tools\n`,
      "packs/tools/pack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Pack\nmetadata:\n  name: tools\n  version: 0.1.0\nspec:\n  mcpServers:\n    gh:\n      transport: http\n      url: https://example.invalid/mcp\n      headers:\n        Authorization:\n          fromEnv: MY_SECRET_TOKEN\n`,
    });
    const ws = await loadWorkspace(tmp.dir);
    const result = await validateWorkspace(ws, registry(), await detected(tmp.dir), { env: {} });
    const missing = result.diagnostics.find((d) => d.message.includes("MY_SECRET_TOKEN"));
    expect(missing?.severity).toBe("warning");
  });

  it("detects conflicting MCP server definitions", async () => {
    await writeTree(tmp.dir, {
      "agentpack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Workspace\npacks:\n  - path: ./packs/a\n  - path: ./packs/b\n`,
      "packs/a/pack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Pack\nmetadata:\n  name: a\n  version: 0.1.0\nspec:\n  mcpServers:\n    x:\n      transport: stdio\n      command: node\n`,
      "packs/b/pack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Pack\nmetadata:\n  name: b\n  version: 0.1.0\nspec:\n  mcpServers:\n    x:\n      transport: stdio\n      command: deno\n`,
    });
    const ws = await loadWorkspace(tmp.dir);
    const result = await validateWorkspace(ws, registry(), await detected(tmp.dir), { env: {} });
    expect(result.diagnostics.some((d) => d.message.includes("conflicting MCP server"))).toBe(true);
  });
});

describe("strictness", () => {
  const report = {
    findings: [
      {
        target: "codex" as const,
        componentType: "hook" as const,
        componentId: "h",
        support: "unsupported" as const,
      },
      {
        target: "codex" as const,
        componentType: "mcp" as const,
        componentId: "m",
        support: "degraded" as const,
      },
      {
        target: "codex" as const,
        componentType: "skill" as const,
        componentId: "s",
        support: "transpiled" as const,
      },
    ],
  };

  it("permissive warns only", () => {
    const diags = strictnessDiagnostics([report], "permissive");
    expect(diags.every((d) => d.severity === "warning")).toBe(true);
    expect(diags).toHaveLength(3);
  });

  it("strict fails on degraded and unsupported", () => {
    const diags = strictnessDiagnostics([report], "strict");
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(2);
  });

  it("portable fails on degraded and unsupported", () => {
    const diags = strictnessDiagnostics([report], "portable");
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(2);
  });
});

describe("trust", () => {
  it("requires trust for packs with executable components and invalidates on change", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const pack = ws.packs[0]!.pack!;
    const req = await trustRequirement(pack);
    expect(req.localMcpCommands).toBe(1);

    const { refusals } = await evaluateTrust([pack], {}, []);
    expect(refusals).toHaveLength(1);

    const granted = { [req.pack]: { contentHash: req.contentHash, grantedAt: "t" } };
    expect((await evaluateTrust([pack], granted, [])).refusals).toHaveLength(0);

    const changed = { [req.pack]: { contentHash: "sha256:other", grantedAt: "t" } };
    expect((await evaluateTrust([pack], changed, [])).refusals).toHaveLength(1);

    expect((await evaluateTrust([pack], {}, ["tools"])).newlyTrusted).toHaveLength(1);
  });

  it("invalidates trust when a script file's content changes", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      "packs/tools/skills/tools/scripts/run.mjs": "console.log('v1');\n",
    });
    const before = await loadWorkspace(tmp.dir);
    const reqBefore = await trustRequirement(before.packs[0]!.pack!);

    await writeTree(tmp.dir, {
      "packs/tools/skills/tools/scripts/run.mjs": "console.log('v2-CHANGED');\n",
    });
    const after = await loadWorkspace(tmp.dir);
    const reqAfter = await trustRequirement(after.packs[0]!.pack!);
    expect(reqAfter.scriptFiles).toBe(1);
    expect(reqAfter.contentHash).not.toBe(reqBefore.contentHash);

    const granted = { tools: { contentHash: reqBefore.contentHash, grantedAt: "t" } };
    expect((await evaluateTrust([after.packs[0]!.pack!], granted, [])).refusals).toHaveLength(1);
  });
});

describe("plan / sync / diff", () => {
  it("plan never writes files", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const plan = await buildPlan(ws, registry(), await detected(tmp.dir), {
      homeDir: home.dir,
      env: {},
    });
    expect(plan.installStrategy).toBe("symlink");
    expect(plan.targets[0]?.operations.length).toBeGreaterThan(0);
    await expect(fs.stat(path.join(tmp.dir, ".claude"))).rejects.toThrow();
  });

  it("sync writes config, is idempotent, and records state", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);

    const first = await syncWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
    });
    expect(first.applied).toBe(true);
    expect(first.conflicts).toHaveLength(0);

    const skillLink = path.join(tmp.dir, ".claude", "skills", "tools");
    expect((await fs.lstat(skillLink)).isSymbolicLink()).toBe(true);
    const mcp = JSON.parse(await fs.readFile(path.join(tmp.dir, ".claude", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.local.command).toBe("node");
    const instructions = await fs.readFile(
      path.join(tmp.dir, ".claude", "INSTRUCTIONS.md"),
      "utf8",
    );
    expect(instructions).toContain("<!-- agentpack:begin baseline -->");

    const second = await syncWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
    });
    const changes = second.plan.targets.flatMap((t) =>
      t.operations.filter((o) => o.action !== "noop"),
    );
    expect(changes).toHaveLength(0);

    const state = await loadState(tmp.dir);
    expect(state.targets["claude"]?.ownedFiles.length).toBeGreaterThan(0);
    expect(state.trust?.["tools"]).toBeDefined();
  });

  it("refuses sync for untrusted executable packs (exit-worthy trust refusal)", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const result = await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {} });
    expect(result.applied).toBe(false);
    expect(result.trustRefusals).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.message.includes("--trust tools"))).toBe(true);
  });

  it("dry-run applies nothing", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const result = await syncWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
      dryRun: true,
    });
    expect(result.applied).toBe(false);
    await expect(fs.stat(path.join(tmp.dir, ".claude"))).rejects.toThrow();
  });

  it("detects external modification as a conflict, and --force overrides", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });

    const mcpPath = path.join(tmp.dir, ".claude", "mcp.json");
    const parsed = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    parsed.mcpServers.local.command = "HACKED";
    await fs.writeFile(mcpPath, JSON.stringify(parsed, null, 2));

    const conflicted = await syncWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
    });
    expect(conflicted.applied).toBe(false);
    expect(conflicted.conflicts.length).toBeGreaterThan(0);

    const forced = await syncWorkspace(ws, registry(), {
      homeDir: home.dir,
      env: {},
      trust: ["tools"],
      force: true,
    });
    expect(forced.applied).toBe(true);
    const restored = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(restored.mcpServers.local.command).toBe("node");
  });

  it("preserves unmanaged content in merged files", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify(
        { mcpServers: { mine: { command: "keep" } }, otherKey: 1 },
        null,
        2,
      ),
      ".claude/INSTRUCTIONS.md": "# my notes\n\ndo not touch\n",
    });
    const ws = await loadWorkspace(tmp.dir);
    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });

    const mcp = JSON.parse(await fs.readFile(path.join(tmp.dir, ".claude", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.mine.command).toBe("keep");
    expect(mcp.otherKey).toBe(1);
    const instructions = await fs.readFile(
      path.join(tmp.dir, ".claude", "INSTRUCTIONS.md"),
      "utf8",
    );
    expect(instructions).toContain("do not touch");
    expect(instructions).toContain("agentpack:begin baseline");
  });

  it("diff reports differences then becomes clean after sync", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const before = await diffWorkspace(ws, registry(), { homeDir: home.dir, env: {} });
    expect(before.clean).toBe(false);
    expect(before.entries.length).toBeGreaterThan(0);

    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });
    const after = await diffWorkspace(ws, registry(), { homeDir: home.dir, env: {} });
    expect(after.clean).toBe(true);
  });

  it("remove deletes only owned files and keys", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": JSON.stringify({ mcpServers: { mine: { command: "keep" } } }, null, 2),
    });
    const ws = await loadWorkspace(tmp.dir);
    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });

    const result = await removePack(ws, registry(), "tools", { homeDir: home.dir, env: {} });
    expect(result.skipped.filter((s) => s.reason.includes("modified externally"))).toHaveLength(0);
    await expect(fs.lstat(path.join(tmp.dir, ".claude", "skills", "tools"))).rejects.toThrow();
    const mcp = JSON.parse(await fs.readFile(path.join(tmp.dir, ".claude", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.mine.command).toBe("keep");
    expect(mcp.mcpServers.local).toBeUndefined();

    const state = await loadState(tmp.dir);
    expect(state.targets["claude"]?.ownedFiles).toHaveLength(0);
  });

  it("rollback restores the pre-sync state", async () => {
    await writeWorkspace(tmp.dir);
    await writeTree(tmp.dir, {
      ".claude/mcp.json": `{"mcpServers":{"mine":{"command":"keep"}}}\n`,
    });
    const ws = await loadWorkspace(tmp.dir);
    await syncWorkspace(ws, registry(), { homeDir: home.dir, env: {}, trust: ["tools"] });
    const corrupted = JSON.parse(
      await fs.readFile(path.join(tmp.dir, ".claude", "mcp.json"), "utf8"),
    );
    expect(corrupted.mcpServers.local).toBeDefined();

    const result = await rollback(tmp.dir);
    expect(result.restored.length).toBeGreaterThan(0);
    const restored = JSON.parse(
      await fs.readFile(path.join(tmp.dir, ".claude", "mcp.json"), "utf8"),
    );
    expect(restored.mcpServers.local).toBeUndefined();
    expect(restored.mcpServers.mine.command).toBe("keep");
  });
});

describe("loadPack details", () => {
  it("warns about hardcoded secrets without printing values", async () => {
    await writeTree(tmp.dir, {
      "pack.yaml": `apiVersion: agentpack.dev/v1alpha1\nkind: Pack\nmetadata:\n  name: p\n  version: 0.1.0\nspec:\n  mcpServers:\n    gh:\n      transport: http\n      url: https://example.invalid\n      headers:\n        Authorization:\n          value: ghp_1234567890abcdefghijklmnop\n`,
    });
    const result = await loadPack(tmp.dir);
    const warning = result.diagnostics.find((d) => d.message.includes("hardcoded secret"));
    expect(warning).toBeDefined();
    expect(warning!.message).not.toContain("ghp_");
  });
});
