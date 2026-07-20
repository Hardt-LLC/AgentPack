import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import { sha256 } from "@agentpack/filesystem";
import type { TargetAdapter } from "@agentpack/schema";
import { createRegistry, importFromTarget, loadWorkspace } from "../src/index.js";
import { createFakeAdapter, writeWorkspace } from "./helpers.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  tmp = await makeTempDir();
});
afterEach(async () => {
  await tmp.cleanup();
});

function importingAdapter(): TargetAdapter {
  const base = createFakeAdapter("claude");
  return {
    ...base,
    async import() {
      return {
        skills: [
          {
            name: "native-skill",
            description: "imported",
            files: { "SKILL.md": "---\nname: native-skill\ndescription: imported\n---\n" },
            contentHash: "sha256:abc",
          },
        ],
        mcpServers: {
          local: { transport: "stdio", command: "node", enabled: true },
        },
        instructions: [{ id: "notes", content: "# notes\n", scope: "project" as const }],
        extensions: { rawSetting: true },
        warnings: ["sample warning"],
      };
    },
  };
}

describe("importFromTarget", () => {
  it("writes a canonical pack from imported native config", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const result = await importFromTarget(ws, createRegistry([importingAdapter()]), "claude", {
      dryRun: false,
    });
    expect(result.skillsWritten).toEqual(["native-skill"]);
    expect(result.mcpServerCount).toBe(1);
    expect(result.instructionCount).toBe(1);
    expect(result.warnings).toContain("sample warning");

    const packYaml = await fs.readFile(
      path.join(tmp.dir, "packs", "imported-claude", "pack.yaml"),
      "utf8",
    );
    expect(packYaml).toContain("name: imported-claude");
    expect(packYaml).toContain("rawSetting: true");
    await fs.stat(
      path.join(tmp.dir, "packs", "imported-claude", "skills", "native-skill", "SKILL.md"),
    );
    await fs.stat(path.join(tmp.dir, "packs", "imported-claude", "instructions", "notes.md"));
  });

  it("dry-run writes nothing", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const result = await importFromTarget(ws, createRegistry([importingAdapter()]), "claude", {
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    await expect(fs.stat(path.join(tmp.dir, "packs", "imported-claude"))).rejects.toThrow();
  });

  it("skips duplicate skills by content hash", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const skillDir = ws.packs[0]!.pack!.skills[0]!.rootDir;
    const { hashDirectory } = await import("@agentpack/filesystem");
    const existingHash = await hashDirectory(skillDir);

    const adapter = importingAdapter();
    const original = adapter.import!;
    adapter.import = async (ctx) => {
      const result = await original(ctx);
      result.skills.push({
        name: "dup-skill",
        description: "dup",
        files: { "SKILL.md": "x" },
        contentHash: existingHash,
      });
      return result;
    };
    const result = await importFromTarget(ws, createRegistry([adapter]), "claude", {});
    expect(result.skillsSkippedDuplicates).toContain("dup-skill");
    expect(result.skillsWritten).toEqual(["native-skill"]);
  });

  it("errors when the adapter has no importer", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const result = await importFromTarget(
      ws,
      createRegistry([createFakeAdapter("claude")]),
      "claude",
      {},
    );
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("workspace identity", () => {
  it("workspace id depends on manifest content, not location", async () => {
    await writeWorkspace(tmp.dir);
    const ws = await loadWorkspace(tmp.dir);
    const raw = await fs.readFile(path.join(tmp.dir, "agentpack.yaml"), "utf8");
    const { computeWorkspaceId } = await import("@agentpack/filesystem");
    expect(ws.workspaceId).toBe(computeWorkspaceId(tmp.dir, raw));
    expect(computeWorkspaceId("/elsewhere", raw)).toBe(ws.workspaceId);
    expect(computeWorkspaceId(tmp.dir, raw + "\n")).not.toBe(ws.workspaceId);
    expect(sha256("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
