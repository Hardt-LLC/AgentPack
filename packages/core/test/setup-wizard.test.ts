import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import { loadState } from "@agentpack/filesystem";
import type { CanonicalMcpServer, TargetAdapter } from "@agentpack/schema";
import {
  convertSecretsToEnvRefs,
  createRegistry,
  curatePack,
  ensureDefaultProfile,
  grantPackTrust,
  importFromTarget,
  loadWorkspace,
  parsePackManifest,
  readPackCurationInfo,
  registerPackInWorkspace,
  requiresTrust,
  scanPackSecrets,
  syncWorkspace,
  trustRequirement,
} from "../src/index.js";
import { createFakeAdapter, writeWorkspace } from "./helpers.js";

let tmp: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  tmp = await makeTempDir();
});
afterEach(async () => {
  await tmp.cleanup();
});

async function writePack(dir: string, packYaml: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "pack.yaml"), packYaml);
  return path.join(dir, "pack.yaml");
}

async function readPackYaml(packYamlPath: string): Promise<Record<string, unknown>> {
  return parseYaml(await fs.readFile(packYamlPath, "utf8")) as Record<string, unknown>;
}

function specOf(doc: Record<string, unknown>): Record<string, unknown> {
  return doc.spec as Record<string, unknown>;
}

describe("curatePack", () => {
  it("removes unselected servers and skill dirs, normalizes server names", async () => {
    const packDir = path.join(tmp.dir, "packs", "imported-claude");
    await fs.mkdir(path.join(packDir, "skills", "keepme"), { recursive: true });
    await fs.writeFile(path.join(packDir, "skills", "keepme", "SKILL.md"), "# keep\n");
    await fs.mkdir(path.join(packDir, "skills", "dropme"), { recursive: true });
    await fs.writeFile(path.join(packDir, "skills", "dropme", "SKILL.md"), "# drop\n");
    const packYamlPath = await writePack(
      packDir,
      `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: imported-claude
  version: 0.1.0
spec:
  skills:
    - path: ./skills/keepme
    - path: ./skills/dropme
  instructions:
    - id: notes
      path: ./instructions/notes.md
  mcpServers:
    GoodServer Name:
      transport: stdio
      command: node
    dropme:
      transport: stdio
      command: node
`,
    );

    const result = await curatePack(packDir, {
      keepServers: ["GoodServer Name"],
      keepSkills: ["keepme"],
      keepInstructions: false,
    });

    expect(result.keptServers).toEqual(["goodserver-name"]);
    expect(result.removedServers).toEqual(["dropme"]);
    expect(result.renamedServers).toEqual([{ from: "GoodServer Name", to: "goodserver-name" }]);
    expect(result.keptSkills).toEqual(["keepme"]);
    expect(result.removedSkills).toEqual(["dropme"]);
    expect(result.removedInstructions).toEqual(["notes"]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "info" && d.message.includes('"GoodServer Name" renamed'),
      ),
    ).toBe(true);

    const doc = specOf(await readPackYaml(packYamlPath));
    expect(Object.keys(doc.mcpServers as Record<string, unknown>)).toEqual(["goodserver-name"]);
    expect(doc.skills).toEqual([{ path: "./skills/keepme" }]);
    expect(doc.instructions).toEqual([]);

    // Unselected skill directory removed; selected one kept.
    await expect(fs.stat(path.join(packDir, "skills", "dropme"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(packDir, "skills", "keepme", "SKILL.md")),
    ).resolves.toBeDefined();

    // The rewritten manifest still parses as a valid pack.
    const { manifest, diagnostics } = parsePackManifest(
      await fs.readFile(packYamlPath, "utf8"),
      packYamlPath,
    );
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(manifest?.metadata.name).toBe("imported-claude");
  });

  it("keeps everything when no selection is given", async () => {
    const packDir = path.join(tmp.dir, "pack");
    const packYamlPath = await writePack(
      packDir,
      `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: p
  version: 0.1.0
spec:
  mcpServers:
    alpha:
      transport: stdio
      command: node
`,
    );
    const result = await curatePack(packDir, {});
    expect(result.keptServers).toEqual(["alpha"]);
    expect(result.removedServers).toEqual([]);
    const doc = specOf(await readPackYaml(packYamlPath));
    expect(Object.keys(doc.mcpServers as Record<string, unknown>)).toEqual(["alpha"]);
  });
});

describe("convertSecretsToEnvRefs", () => {
  it("converts only secret-looking literal values", async () => {
    const packDir = path.join(tmp.dir, "pack");
    const packYamlPath = await writePack(
      packDir,
      `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: p
  version: 0.1.0
spec:
  mcpServers:
    alpha:
      transport: stdio
      command: node
      env:
        API_KEY:
          value: sk-abcdefghijklmnop123456
        PLAIN:
          value: hello-world
        ALREADY_REF:
          fromEnv: EXISTING
      headers:
        X-Normal:
          value: text/plain
`,
    );

    const converted = await convertSecretsToEnvRefs(packYamlPath);
    expect(converted).toBe(1);

    const doc = specOf(await readPackYaml(packYamlPath));
    const alpha = (doc.mcpServers as Record<string, Record<string, unknown>>).alpha!;
    const env = alpha.env as Record<string, unknown>;
    expect(env.API_KEY).toEqual({ fromEnv: "API_KEY" });
    expect(env.PLAIN).toEqual({ value: "hello-world" });
    expect(env.ALREADY_REF).toEqual({ fromEnv: "EXISTING" });
    const headers = alpha.headers as Record<string, unknown>;
    expect(headers["X-Normal"]).toEqual({ value: "text/plain" });
    expect(await fs.readFile(packYamlPath, "utf8")).not.toContain("sk-abcdefghijklmnop123456");
  });

  it("leaves a secret-free file untouched", async () => {
    const packDir = path.join(tmp.dir, "pack");
    const packYamlPath = await writePack(
      packDir,
      `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: p
  version: 0.1.0
spec:
  mcpServers:
    alpha:
      transport: stdio
      command: node
      env:
        PLAIN:
          value: hello-world
`,
    );
    const before = await fs.readFile(packYamlPath, "utf8");
    expect(await convertSecretsToEnvRefs(packYamlPath)).toBe(0);
    expect(await fs.readFile(packYamlPath, "utf8")).toBe(before);
  });
});

describe("scanPackSecrets", () => {
  it("reports pattern names only, never values", async () => {
    const packDir = path.join(tmp.dir, "pack");
    const packYamlPath = await writePack(
      packDir,
      `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: p
  version: 0.1.0
spec:
  mcpServers:
    alpha:
      transport: stdio
      command: node
      env:
        API_KEY:
          value: sk-abcdefghijklmnop123456
`,
    );
    const scans = await scanPackSecrets([packYamlPath]);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.findings.map((f) => f.pattern)).toContain("openai-api-key");
    expect(JSON.stringify(scans)).not.toContain("sk-abcdefghijklmnop123456");
  });
});

describe("readPackCurationInfo", () => {
  it("reads packs that fail schema validation (names pending normalization)", async () => {
    const packDir = path.join(tmp.dir, "pack");
    await writePack(
      packDir,
      `apiVersion: agentpack.dev/v1alpha1
kind: Pack
metadata:
  name: imported-codex
  version: 0.1.0
spec:
  skills:
    - path: ./skills/alpha
  instructions:
    - id: notes
      path: ./instructions/notes.md
  mcpServers:
    node_repl:
      transport: stdio
      command: node
    legacy:
      transport: stdio
      command: node
      enabled: false
`,
    );
    // Not parseable as a manifest (node_repl violates NAME_PATTERN)…
    const { manifest } = parsePackManifest(
      await fs.readFile(path.join(packDir, "pack.yaml"), "utf8"),
      "pack.yaml",
    );
    expect(manifest).toBeUndefined();
    // …but curation info is still available.
    const info = await readPackCurationInfo(packDir);
    expect(info.parseError).toBeUndefined();
    expect(info.servers).toEqual([
      { name: "node_repl", enabled: true },
      { name: "legacy", enabled: false },
    ]);
    expect(info.skills).toEqual(["alpha"]);
    expect(info.instructionCount).toBe(1);

    // Curating with the defaults (enabled servers kept) normalizes the name
    // and makes the pack valid.
    const curated = await curatePack(packDir, { keepServers: ["node_repl"] });
    expect(curated.keptServers).toEqual(["node-repl"]);
    const reparsed = parsePackManifest(
      await fs.readFile(path.join(packDir, "pack.yaml"), "utf8"),
      "pack.yaml",
    );
    expect(reparsed.manifest?.metadata.name).toBe("imported-codex");
  });
});

describe("ensureDefaultProfile", () => {
  it("enables gateway mode and preserves existing packs entries", async () => {
    await writeWorkspace(tmp.dir);
    await ensureDefaultProfile(tmp.dir, {
      packs: ["tools"],
      targets: ["claude"],
      scope: "user",
      gateway: true,
    });
    const workspace = await loadWorkspace(tmp.dir);
    expect(workspace.manifest?.gateway?.enabled).toBe(true);
    expect(workspace.manifest?.profiles["default"]?.scope).toBe("user");
    // Existing workspace packs list entries are preserved.
    expect(workspace.manifest?.packs).toContainEqual({ path: "./packs/tools" });
  });
});

describe("setup wizard steps (import → curate → profile → trust → apply)", () => {
  function importingAdapter(): TargetAdapter {
    const base = createFakeAdapter("claude");
    const server: Omit<CanonicalMcpServer, "name"> = {
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      enabled: true,
    };
    return {
      ...base,
      async import() {
        return {
          skills: [
            {
              name: "imported-skill",
              description: "imported",
              files: {
                "SKILL.md": "---\nname: imported-skill\ndescription: imported\n---\n\n# imported\n",
              },
              contentHash: "sha256:imported-skill-unique",
            },
          ],
          mcpServers: { FreshServer: server },
          instructions: [],
          extensions: {},
          warnings: [],
        };
      },
    };
  }

  it("runs the full step chain in tmp dirs", async () => {
    await writeWorkspace(tmp.dir);
    const registry = createRegistry([importingAdapter()]);

    // Import step.
    const imported = await importFromTarget(await loadWorkspace(tmp.dir), registry, "claude", {
      scope: "user",
      homeDir: tmp.dir,
    });
    expect(imported.packName).toBe("imported-claude");
    expect(imported.mcpServerCount).toBe(1);
    expect(imported.skillsWritten).toEqual(["imported-skill"]);

    await registerPackInWorkspace(tmp.dir, imported.packName);
    let workspace = await loadWorkspace(tmp.dir);
    expect(workspace.manifest?.packs).toContainEqual({ path: "./packs/imported-claude" });

    // Curation step: keep everything, but names get normalized.
    const curated = await curatePack(imported.packDir, {});
    expect(curated.keptServers).toEqual(["freshserver"]);
    expect(curated.renamedServers).toEqual([{ from: "FreshServer", to: "freshserver" }]);

    // Profile step (individual MCP delivery — gateway delivery is covered
    // separately below because gateway mode filters per-server artifacts).
    await ensureDefaultProfile(tmp.dir, {
      packs: ["tools", "imported-claude"],
      targets: ["claude"],
      scope: "user",
    });
    workspace = await loadWorkspace(tmp.dir);
    const profile = workspace.manifest?.profiles["default"];
    expect(profile?.packs).toEqual(["tools", "imported-claude"]);
    expect(profile?.scope).toBe("user");

    // Trust step: the imported pack has a stdio server → requires trust.
    // (The wizard asks per pack; here we grant both profile packs.)
    for (const name of ["tools", "imported-claude"]) {
      const pack = workspace.packs.find((p) => p.pack?.metadata.name === name)?.pack;
      expect(pack).toBeDefined();
      const requirement = await trustRequirement(pack!);
      expect(requiresTrust(requirement)).toBe(true);
      await grantPackTrust(tmp.dir, pack!);
      const state = await loadState(tmp.dir);
      expect(state.trust?.[name]?.contentHash).toBe(requirement.contentHash);
    }

    // Apply step: recorded trust lets sync pass without --trust.
    const sync = await syncWorkspace(await loadWorkspace(tmp.dir), registry, {
      homeDir: tmp.dir,
      trust: [],
    });
    expect(sync.trustRefusals).toEqual([]);
    expect(sync.conflicts).toEqual([]);
    expect(sync.applied).toBe(true);

    // User scope on the fake adapter writes <home>/.claude/mcp.json.
    const mcp = JSON.parse(
      await fs.readFile(path.join(tmp.dir, ".claude", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toContain("freshserver");
  });
});
