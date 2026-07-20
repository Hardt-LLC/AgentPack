import { promises as fs } from "node:fs";
import path from "node:path";

import type { CanonicalHook, CanonicalMcpServer, CanonicalSkill } from "@agentpack/schema";
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

const server: CanonicalMcpServer = {
  name: "github",
  transport: "stdio",
  command: "npx",
  env: { GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" } },
  enabled: true,
};

const hook: CanonicalHook = {
  id: "lint",
  event: "preToolUse",
  matcher: "shell",
  command: ["pnpm", "lint"],
};

function bundlePack(tmp: string) {
  return makePack(path.join(tmp, "pack"), {
    metadata: { name: "test-pack", version: "1.0.0", description: "A test pack" },
    skills: [skill],
    mcpServers: { github: server },
    hooks: [hook],
    plugin: {
      enabled: true,
      interface: { displayName: "Test Pack", categories: ["devtools"] },
    },
  });
}

function fileContent(artifacts: Awaited<ReturnType<typeof generateKimi>>, relPath: string): string {
  const artifact = artifacts.find((a) => a.kind === "file" && a.relPath === relPath);
  if (artifact?.kind !== "file") throw new Error(`missing file artifact ${relPath}`);
  return artifact.content;
}

describe("plugin bundle", () => {
  it("emits an exact kimi.plugin.json manifest", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "pack", "assets"), { recursive: true });
    await fs.writeFile(path.join(tmp, "pack", "assets", "logo.svg"), "<svg/>");

    const artifacts = await generateKimi(
      bundlePack(tmp),
      makeContext(tmp, { options: { bundle: true } }),
    );
    const manifest = JSON.parse(fileContent(artifacts, "kimi.plugin.json"));

    expect(manifest).toEqual({
      name: "test-pack",
      version: "1.0.0",
      description: "A test pack",
      interface: { displayName: "Test Pack", categories: ["devtools"] },
      skills: ["skills/review"],
      hooks: "./hooks",
      mcpServers: {
        github: { type: "stdio", command: "npx", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
      },
      assets: "./assets",
    });
    expect(Object.keys(manifest)).toEqual([
      "name",
      "version",
      "description",
      "interface",
      "skills",
      "hooks",
      "mcpServers",
      "assets",
    ]);
  });

  it("emits hooks/hooks.json with the full grouped hooks object", async () => {
    const tmp = await makeTmpDir();
    const artifacts = await generateKimi(
      bundlePack(tmp),
      makeContext(tmp, { options: { bundle: true } }),
    );

    expect(JSON.parse(fileContent(artifacts, "hooks/hooks.json"))).toEqual({
      hooks: {
        preToolUse: [{ id: "lint", matcher: "shell", command: ["pnpm", "lint"] }],
      },
    });
  });

  it("omits hooks, mcpServers and assets keys when absent", async () => {
    const tmp = await makeTmpDir();
    const pack = makePack(path.join(tmp, "pack"), {
      skills: [skill],
      plugin: { enabled: true },
    });
    const artifacts = await generateKimi(pack, makeContext(tmp, { options: { bundle: true } }));
    const manifest = JSON.parse(fileContent(artifacts, "kimi.plugin.json"));

    expect(manifest).toEqual({ name: "test-pack", version: "1.0.0", skills: ["skills/review"] });
    expect(artifacts.some((a) => a.kind === "file" && a.relPath === "hooks/hooks.json")).toBe(
      false,
    );
    expect(artifacts.some((a) => a.relPath === "assets")).toBe(false);
  });

  it("skips disabled servers in the bundle manifest", async () => {
    const tmp = await makeTmpDir();
    const pack = bundlePack(tmp);
    pack.mcpServers = {
      off: { name: "off", transport: "stdio", command: "x", enabled: false },
    };
    const artifacts = await generateKimi(pack, makeContext(tmp, { options: { bundle: true } }));
    const manifest = JSON.parse(fileContent(artifacts, "kimi.plugin.json"));
    expect(manifest.mcpServers).toBeUndefined();
  });

  it("plans bundle operations under bundleRoot with copies only", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "pack", "assets"), { recursive: true });
    await fs.writeFile(path.join(tmp, "pack", "assets", "logo.svg"), "<svg/>");

    const artifacts = await generateKimi(
      bundlePack(tmp),
      makeContext(tmp, { options: { bundle: true } }),
    );
    const bundleRoot = path.join(tmp, "dist", "kimi", "test-pack");
    const ops = await planKimiInstall(
      artifacts,
      makeInstallContext(tmp, {
        installMode: "copy",
        symlinksReliable: false,
        bundleRoot,
        options: { bundle: true },
      }),
    );

    expect(ops).toEqual([
      {
        type: "writeFile",
        path: path.join(bundleRoot, "kimi.plugin.json"),
        content: fileContent(artifacts, "kimi.plugin.json"),
        executable: undefined,
      },
      {
        type: "copyDirectory",
        source: "/packs/test/skills/review",
        dest: path.join(bundleRoot, "skills", "review"),
      },
      {
        type: "writeFile",
        path: path.join(bundleRoot, "hooks", "hooks.json"),
        content: fileContent(artifacts, "hooks/hooks.json"),
        executable: undefined,
      },
      {
        type: "copyDirectory",
        source: path.join(tmp, "pack", "assets"),
        dest: path.join(bundleRoot, "assets"),
      },
    ]);
    expect(ops.some((o) => o.type === "createSymlink")).toBe(false);
  });

  it("is deterministic across runs", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.join(tmp, "pack", "assets"), { recursive: true });
    await fs.writeFile(path.join(tmp, "pack", "assets", "logo.svg"), "<svg/>");

    const first = await generateKimi(
      bundlePack(tmp),
      makeContext(tmp, { options: { bundle: true } }),
    );
    const second = await generateKimi(
      bundlePack(tmp),
      makeContext(tmp, { options: { bundle: true } }),
    );
    expect(second).toEqual(first);
  });

  it("throws when bundle artifacts are planned without bundleRoot", async () => {
    const tmp = await makeTmpDir();
    const artifacts = await generateKimi(
      bundlePack(tmp),
      makeContext(tmp, { options: { bundle: true } }),
    );
    await expect(planKimiInstall(artifacts, makeInstallContext(tmp))).rejects.toThrow(/bundleRoot/);
  });
});
