/**
 * Golden-output fixture tests for the three real target adapters.
 *
 * Fixture layout (repo root `fixtures/`):
 *   fixtures/<target>/<category>/input/    a complete pack directory
 *   fixtures/<target>/<category>/given/    pre-existing native files (optional)
 *   fixtures/<target>/<category>/expected/ the golden output
 *   fixtures/duplicate-skill-conflict/     workspace-level fixture (once)
 *
 * Comparison strategy per category:
 * - operations.json (skill-only, skill-mcp, target-override): the adapter's
 *   planned InstallOperation list, serialized with absolute paths replaced by
 *   placeholders ($PACK = pack input dir, $PROJECT = /workspace,
 *   $HOME = /home/user) so goldens are machine-independent.
 * - applied tree (plugin-bundle, instructions-merge, env-secret-reference,
 *   mcp-multiple): operations are applied into a tmp dir
 *   (projectRoot = <tmp>/ws, homeDir = <tmp>/home, bundleRoot = <tmp>/bundle)
 *   and the resulting file tree is compared byte-exactly against expected/.
 *   The expected tree mirrors the apply root: the project root for sync
 *   fixtures (e.g. expected/CLAUDE.md, expected/.claude/skills/...) and the
 *   bundle root for plugin-bundle (e.g. expected/.codex-plugin/plugin.json).
 *   A fixture's given/ tree is copied into the apply root before applying.
 * - capability-report.json (unsupported-capability): analyze() output.
 * - diagnostics.json (duplicate-skill-conflict): validateWorkspace output.
 *
 * Regenerate goldens intentionally with AGENTPACK_UPDATE_FIXTURES=1.
 */
import { promises as fs, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { claudeAdapter } from "@agentpack/adapter-claude";
import { codexAdapter } from "@agentpack/adapter-codex";
import { kimiAdapter } from "@agentpack/adapter-kimi";
import { applyOperations, type InstallOperation } from "@agentpack/filesystem";
import type {
  AdapterContext,
  Diagnostic,
  InstallContext,
  InstallOperationLike,
  TargetAdapter,
  TargetDetection,
  TargetId,
} from "@agentpack/schema";
import { makeTempDir, readTree, writeTree } from "@agentpack/testing";
import { describe, expect, it } from "vitest";

import { createRegistry } from "../src/registry.js";
import { loadPack } from "../src/load-pack.js";
import { loadWorkspace } from "../src/load-workspace.js";
import { validateWorkspace } from "../src/validate.js";

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
);

const UPDATE = process.env.AGENTPACK_UPDATE_FIXTURES === "1";

const ADAPTERS: Partial<Record<TargetId, TargetAdapter>> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  kimi: kimiAdapter,
};

type FixtureMode = "operations" | "tree" | "report";

const CATEGORY_MODE: Record<string, FixtureMode> = {
  "skill-only": "operations",
  "skill-mcp": "operations",
  "plugin-bundle": "tree",
  "instructions-merge": "tree",
  "target-override": "operations",
  "unsupported-capability": "report",
  "env-secret-reference": "tree",
  "mcp-multiple": "tree",
};

/** Detection roots matching each adapter's defaults for the given roots. */
function fakeDetection(target: TargetId, ws: string, home: string): TargetDetection {
  const dir = target === "kimi" ? ".kimi-code" : `.${target}`;
  return {
    installed: true,
    executablePath: `/fake/bin/${target}`,
    version: "1.0.0",
    userConfigRoot: path.join(home, dir),
    projectConfigRoot: path.join(ws, dir),
    warnings: [],
  };
}

function adapterContext(
  target: TargetId,
  ws: string,
  home: string,
  options: Record<string, unknown> = {},
): AdapterContext {
  return {
    scope: "project",
    projectRoot: ws,
    homeDir: home,
    env: {},
    detection: fakeDetection(target, ws, home),
    options,
  };
}

function installContext(
  target: TargetId,
  ws: string,
  home: string,
  overrides: Partial<InstallContext> = {},
): InstallContext {
  return {
    ...adapterContext(target, ws, home, overrides.options ?? {}),
    installMode: "auto",
    symlinksReliable: true,
    ...overrides,
  };
}

/* ------------------------- normalization ----------------------------- */

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Replace absolute roots with stable placeholders, longest paths first. */
function normalizePath(p: string, roots: Record<string, string>): string {
  let out = toPosix(p);
  const entries = Object.entries(roots).sort((a, b) => b[1].length - a[1].length);
  for (const [placeholder, abs] of entries) {
    out = out.split(toPosix(abs)).join(placeholder);
  }
  return out;
}

type SerializedOperation = Record<string, unknown>;

function serializeOperations(
  ops: InstallOperationLike[],
  roots: Record<string, string>,
): SerializedOperation[] {
  return ops.map((op) => {
    switch (op.type) {
      case "writeFile":
        return {
          type: op.type,
          path: normalizePath(op.path, roots),
          content: op.content,
          ...(op.executable ? { executable: true } : {}),
        };
      case "mergeJson":
        return {
          type: op.type,
          path: normalizePath(op.path, roots),
          pointer: op.pointer,
          value: op.value,
        };
      case "mergeToml":
        return {
          type: op.type,
          path: normalizePath(op.path, roots),
          table: op.table,
          value: op.value,
        };
      case "managedMarkdownSection":
        return {
          type: op.type,
          path: normalizePath(op.path, roots),
          sectionId: op.sectionId,
          content: op.content,
          ...(op.append ? { append: true } : {}),
        };
      case "createSymlink":
        return {
          type: op.type,
          path: normalizePath(op.path, roots),
          target: normalizePath(op.target, roots),
        };
      case "copyDirectory":
        return {
          type: op.type,
          source: normalizePath(op.source, roots),
          dest: normalizePath(op.dest, roots),
        };
      case "removeOwnedPath":
        return { type: op.type, path: normalizePath(op.path, roots) };
    }
  });
}

/* ---------------------- golden file helpers -------------------------- */

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function expectJsonGolden(file: string, actual: unknown): Promise<void> {
  const rendered = renderJson(actual);
  if (UPDATE) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, rendered);
    return;
  }
  const expected = await fs.readFile(file, "utf8").catch(() => undefined);
  if (expected === undefined) {
    throw new Error(`missing golden file ${file} — regenerate with AGENTPACK_UPDATE_FIXTURES=1`);
  }
  expect(rendered).toBe(expected);
}

async function expectTreeGolden(dir: string, actual: Record<string, string>): Promise<void> {
  if (UPDATE) {
    await fs.rm(dir, { recursive: true, force: true });
    await writeTree(dir, actual);
    return;
  }
  const expected = await readTree(dir).catch(() => undefined);
  if (expected === undefined) {
    throw new Error(`missing golden tree ${dir} — regenerate with AGENTPACK_UPDATE_FIXTURES=1`);
  }
  expect(actual).toEqual(expected);
}

/* --------------------------- fixture runs ---------------------------- */

interface Fixture {
  target: TargetId;
  category: string;
  dir: string;
}

function discoverFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const target of Object.keys(ADAPTERS) as TargetId[]) {
    const targetDir = path.join(FIXTURES_ROOT, target);
    for (const category of readdirSync(targetDir).sort()) {
      const dir = path.join(targetDir, category);
      if (!statSync(dir).isDirectory()) continue;
      const mode = CATEGORY_MODE[category];
      if (!mode) throw new Error(`no comparison mode registered for fixture category ${category}`);
      fixtures.push({ target, category, dir });
    }
  }
  return fixtures;
}

async function loadFixturePack(fixture: Fixture) {
  const inputDir = path.join(fixture.dir, "input");
  const { pack, diagnostics } = await loadPack(inputDir);
  expect(
    diagnostics.filter((d) => d.severity === "error"),
    `pack at ${inputDir} must load without errors`,
  ).toEqual([]);
  expect(pack).toBeDefined();
  return pack!;
}

/** Operations mode: fixed placeholder roots, no filesystem output. */
async function runOperationsFixture(fixture: Fixture): Promise<void> {
  const pack = await loadFixturePack(fixture);
  const adapter = ADAPTERS[fixture.target]!;
  const ws = "/workspace";
  const home = "/home/user";

  let ops: InstallOperationLike[] = [];
  if (pack.targetEnabled[fixture.target] === false) {
    // The core engine skips packs disabled for a target: no artifacts at all.
    ops = [];
  } else {
    const artifacts = await adapter.generate(pack, adapterContext(fixture.target, ws, home));
    ops = await adapter.planInstall(artifacts, installContext(fixture.target, ws, home));
  }

  const serialized = serializeOperations(ops, {
    $PACK: pack.rootDir,
    $PROJECT: ws,
    $HOME: home,
  });
  await expectJsonGolden(path.join(fixture.dir, "expected", "operations.json"), serialized);
}

/** Tree mode: apply operations into a tmp dir, compare the file tree. */
async function runTreeFixture(fixture: Fixture): Promise<void> {
  const pack = await loadFixturePack(fixture);
  const adapter = ADAPTERS[fixture.target]!;
  const isBundle = fixture.category === "plugin-bundle";

  const tmp = await makeTempDir();
  try {
    const ws = path.join(tmp.dir, "ws");
    const home = path.join(tmp.dir, "home");
    const bundle = path.join(tmp.dir, "bundle");
    await fs.mkdir(ws, { recursive: true });
    await fs.mkdir(home, { recursive: true });

    const applyRoot = isBundle ? bundle : ws;
    // Pre-existing native files (e.g. user-written CLAUDE.md/AGENTS.md).
    const givenDir = path.join(fixture.dir, "given");
    if (await fs.stat(givenDir).catch(() => undefined)) {
      await writeTree(applyRoot, await readTree(givenDir));
    }

    const options = isBundle ? { bundle: true } : {};
    const artifacts = await adapter.generate(
      pack,
      adapterContext(fixture.target, ws, home, options),
    );
    const ops = await adapter.planInstall(
      artifacts,
      installContext(fixture.target, ws, home, {
        options,
        installMode: "copy",
        symlinksReliable: false,
        ...(isBundle ? { bundleRoot: bundle } : {}),
      }),
    );
    await applyOperations(ops as InstallOperation[]);

    const actual = await readTree(applyRoot);
    await expectTreeGolden(path.join(fixture.dir, "expected"), actual);
  } finally {
    await tmp.cleanup();
  }
}

/** Report mode: golden capability analysis. */
async function runReportFixture(fixture: Fixture): Promise<void> {
  const pack = await loadFixturePack(fixture);
  const adapter = ADAPTERS[fixture.target]!;
  const report = await adapter.analyze(
    pack,
    adapterContext(fixture.target, "/workspace", "/home/user"),
  );
  await expectJsonGolden(path.join(fixture.dir, "expected", "capability-report.json"), report);
}

/* ------------------------------ tests -------------------------------- */

describe("golden fixtures", () => {
  const fixtures = discoverFixtures();

  for (const fixture of fixtures) {
    it(`${fixture.target}/${fixture.category}`, async () => {
      switch (CATEGORY_MODE[fixture.category]) {
        case "operations":
          await runOperationsFixture(fixture);
          break;
        case "tree":
          await runTreeFixture(fixture);
          break;
        case "report":
          await runReportFixture(fixture);
          break;
      }
    });
  }

  it("plugin-bundle generation is deterministic", async () => {
    for (const target of Object.keys(ADAPTERS) as TargetId[]) {
      const dir = path.join(FIXTURES_ROOT, target, "plugin-bundle");
      const { pack } = await loadPack(path.join(dir, "input"));
      const adapter = ADAPTERS[target]!;
      const build = async () => {
        const artifacts = await adapter.generate(
          pack!,
          adapterContext(target, "/workspace", "/home/user", { bundle: true }),
        );
        const ops = await adapter.planInstall(
          artifacts,
          installContext(target, "/workspace", "/home/user", {
            options: { bundle: true },
            bundleRoot: "/bundle",
          }),
        );
        return serializeOperations(ops, { $PACK: pack!.rootDir });
      };
      expect(await build()).toEqual(await build());
    }
  });

  it("duplicate-skill-conflict reports a cross-pack diagnostic", async () => {
    const dir = path.join(FIXTURES_ROOT, "duplicate-skill-conflict");
    const workspace = await loadWorkspace(path.join(dir, "input"));
    const registry = createRegistry([codexAdapter, claudeAdapter, kimiAdapter]);
    const result = await validateWorkspace(workspace, registry, {}, { env: {} });

    const normalize = (diagnostics: Diagnostic[]) =>
      diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
        ...(d.source ? { source: normalizePath(d.source, { $ROOT: workspace.rootDir }) } : {}),
      }));
    await expectJsonGolden(
      path.join(dir, "expected", "diagnostics.json"),
      normalize(result.diagnostics),
    );

    expect(result.ok).toBe(false);
    const error = result.diagnostics.find((d) => d.severity === "error");
    expect(error?.message).toContain("provided by both");
  });

  it("env-secret-reference keeps the literal ${SERVICE_TOKEN} reference", async () => {
    for (const target of Object.keys(ADAPTERS) as TargetId[]) {
      const dir = path.join(FIXTURES_ROOT, target, "env-secret-reference");
      const { pack } = await loadPack(path.join(dir, "input"));
      const adapter = ADAPTERS[target]!;
      const tmp = await makeTempDir();
      try {
        const ws = path.join(tmp.dir, "ws");
        const home = path.join(tmp.dir, "home");
        const artifacts = await adapter.generate(pack!, adapterContext(target, ws, home));
        const ops = await adapter.planInstall(
          artifacts,
          installContext(target, ws, home, { installMode: "copy", symlinksReliable: false }),
        );
        await applyOperations(ops as InstallOperation[]);
        const tree = await readTree(ws);
        const combined = Object.values(tree).join("\n");
        expect(combined).toContain("${SERVICE_TOKEN}");
        expect(combined).not.toContain("Bearer token-value");
      } finally {
        await tmp.cleanup();
      }
    }
  });
});
