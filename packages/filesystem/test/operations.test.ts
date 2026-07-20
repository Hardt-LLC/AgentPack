import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyOperations,
  describeOperation,
  planOperations,
  type InstallOperation,
} from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-ops-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function p(rel: string): string {
  return path.join(tmpDir, rel);
}

describe("planOperations", () => {
  it("reports create for missing targets", async () => {
    const planned = await planOperations([
      { type: "writeFile", path: p("a.txt"), content: "a" },
      { type: "mergeJson", path: p("cfg.json"), pointer: "/x", value: 1 },
      { type: "mergeToml", path: p("cfg.toml"), table: ["t"], value: { k: 1 } },
      { type: "managedMarkdownSection", path: p("doc.md"), sectionId: "s", content: "c" },
      { type: "createSymlink", path: p("link"), target: p("a.txt") },
      { type: "copyDirectory", source: p("src"), dest: p("dest") },
    ]);
    // copyDirectory source does not exist here; only the other five are checked.
    expect(planned.slice(0, 5).map((x) => x.action)).toEqual([
      "create",
      "create",
      "create",
      "create",
      "create",
    ]);
    expect(planned[0]!.detail).toContain("create");
  });

  it("reports noop after applying, update after divergence", async () => {
    const ops: InstallOperation[] = [
      { type: "writeFile", path: p("a.txt"), content: "a" },
      { type: "mergeJson", path: p("cfg.json"), pointer: "/x", value: { deep: true } },
      { type: "mergeToml", path: p("cfg.toml"), table: ["t"], value: { k: 1 } },
      { type: "managedMarkdownSection", path: p("doc.md"), sectionId: "s", content: "c" },
      { type: "createSymlink", path: p("link"), target: p("a.txt") },
    ];
    await applyOperations(ops);
    const noopPlan = await planOperations(ops);
    expect(noopPlan.map((x) => x.action)).toEqual(["noop", "noop", "noop", "noop", "noop"]);

    await fs.writeFile(p("a.txt"), "changed");
    const updatePlan = await planOperations(ops);
    expect(updatePlan[0]!.action).toBe("update");
    expect(updatePlan[0]!.detail).toContain("content differs");
    expect(updatePlan[4]!.action).toBe("noop");
  });

  it("reports copyDirectory noop when hashes match", async () => {
    await fs.mkdir(p("src"), { recursive: true });
    await fs.writeFile(p("src/f.txt"), "f");
    const op: InstallOperation = { type: "copyDirectory", source: p("src"), dest: p("dest") };
    expect((await planOperations([op]))[0]!.action).toBe("create");
    await applyOperations([op]);
    expect((await planOperations([op]))[0]!.action).toBe("noop");
    await fs.writeFile(p("dest/extra.txt"), "extra");
    expect((await planOperations([op]))[0]!.action).toBe("update");
  });

  it("reports remove for removeOwnedPath", async () => {
    await fs.writeFile(p("owned.txt"), "x");
    const planned = await planOperations([
      { type: "removeOwnedPath", path: p("owned.txt") },
      { type: "removeOwnedPath", path: p("missing.txt") },
    ]);
    expect(planned[0]!.action).toBe("remove");
    expect(planned[1]!.action).toBe("noop");
  });

  it("does not modify the filesystem", async () => {
    await planOperations([{ type: "writeFile", path: p("a.txt"), content: "a" }]);
    await expect(fs.stat(p("a.txt"))).rejects.toThrow();
  });
});

describe("applyOperations", () => {
  it("applies every operation type", async () => {
    await fs.mkdir(p("src/nested"), { recursive: true });
    await fs.writeFile(p("src/nested/f.txt"), "f");
    await fs.writeFile(p("target.txt"), "t");

    const ops: InstallOperation[] = [
      { type: "writeFile", path: p("out/run.sh"), content: "#!/bin/sh\n", executable: true },
      { type: "mergeJson", path: p("cfg.json"), pointer: "/mcpServers/github", value: { c: 1 } },
      { type: "mergeToml", path: p("cfg.toml"), table: ["mcp_servers", "github"], value: { c: 1 } },
      { type: "managedMarkdownSection", path: p("AGENTS.md"), sectionId: "rules", content: "hi" },
      { type: "createSymlink", path: p("link"), target: p("target.txt") },
      { type: "copyDirectory", source: p("src"), dest: p("dest") },
      { type: "removeOwnedPath", path: p("target.txt") },
    ];
    await applyOperations(ops, { guardRemove: () => true });

    expect((await fs.stat(p("out/run.sh"))).mode & 0o111).not.toBe(0);
    expect(JSON.parse(await fs.readFile(p("cfg.json"), "utf8"))).toEqual({
      mcpServers: { github: { c: 1 } },
    });
    expect(await fs.readFile(p("cfg.toml"), "utf8")).toContain("mcp_servers.github");
    expect(await fs.readFile(p("AGENTS.md"), "utf8")).toContain("agentpack:begin rules");
    expect((await fs.lstat(p("link"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(p("dest/nested/f.txt"), "utf8")).toBe("f");
    await expect(fs.stat(p("target.txt"))).rejects.toThrow();
  });

  it("merges against existing on-disk content", async () => {
    await fs.writeFile(p("cfg.json"), JSON.stringify({ keep: true }));
    await applyOperations([
      { type: "mergeJson", path: p("cfg.json"), pointer: "/added", value: 1 },
    ]);
    expect(JSON.parse(await fs.readFile(p("cfg.json"), "utf8"))).toEqual({
      keep: true,
      added: 1,
    });
  });

  it("refuses removeOwnedPath when the guard rejects it", async () => {
    await fs.writeFile(p("not-owned.txt"), "x");
    await expect(
      applyOperations([{ type: "removeOwnedPath", path: p("not-owned.txt") }], {
        guardRemove: () => false,
      }),
    ).rejects.toThrow(/not owned/);
    expect(await fs.readFile(p("not-owned.txt"), "utf8")).toBe("x");
  });

  it("removes directories via removeOwnedPath", async () => {
    await fs.mkdir(p("owned-dir/sub"), { recursive: true });
    await fs.writeFile(p("owned-dir/sub/f.txt"), "f");
    await applyOperations([{ type: "removeOwnedPath", path: p("owned-dir") }], {
      guardRemove: (target) => target.endsWith("owned-dir"),
    });
    await expect(fs.stat(p("owned-dir"))).rejects.toThrow();
  });
});

describe("describeOperation", () => {
  it("describes every operation type", () => {
    const ops: InstallOperation[] = [
      { type: "writeFile", path: "a", content: "" },
      { type: "mergeJson", path: "a", pointer: "/x", value: 1 },
      { type: "mergeToml", path: "a", table: ["t"], value: {} },
      { type: "managedMarkdownSection", path: "a", sectionId: "s", content: "" },
      { type: "createSymlink", path: "a", target: "b" },
      { type: "copyDirectory", source: "a", dest: "b" },
      { type: "removeOwnedPath", path: "a" },
    ];
    for (const op of ops) {
      expect(describeOperation(op).length).toBeGreaterThan(0);
    }
    expect(describeOperation(ops[4]!)).toBe("symlink a -> b");
  });
});
