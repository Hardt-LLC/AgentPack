import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "@agentpack/testing";
import { buildPlugins, createRegistry, loadWorkspace } from "../src/index.js";
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

describe("buildPlugins", () => {
  it("skips targets whose adapter reports plugin unsupported (never writes real paths)", async () => {
    await writeWorkspace(tmp.dir);
    const syncOnly = createFakeAdapter("claude");
    // Reclassify the plugin as unsupported, mirroring sync-only adapters.
    const baseAnalyze = syncOnly.analyze!;
    syncOnly.analyze = async (pack, ctx) => {
      const report = await baseAnalyze(pack, ctx);
      report.findings.push({
        target: "claude",
        componentType: "plugin",
        componentId: pack.metadata.name,
        support: "unsupported",
        message: "sync-only adapter",
      });
      return report;
    };
    // If buildPlugins honored bundleRoot for this adapter, files would land
    // under dist/; if it leaked, files would land under <ws>/.claude.
    syncOnly.planInstall = async (artifacts, context) => {
      if (context.bundleRoot) {
        throw new Error("sync-only adapter must not be asked to build bundles");
      }
      return createFakeAdapter("claude").planInstall!(artifacts, context);
    };

    const ws = await loadWorkspace(tmp.dir);
    const result = await buildPlugins(ws, createRegistry([syncOnly]), {
      targets: ["claude"],
      env: {},
    });
    expect(result.bundles).toHaveLength(0);
    await expect(fs.stat(path.join(tmp.dir, ".claude"))).rejects.toThrow();
    await expect(fs.stat(path.join(tmp.dir, "dist"))).rejects.toThrow();
  });
});
