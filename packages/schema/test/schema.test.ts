import { describe, expect, it } from "vitest";
import {
  collectEnvVars,
  envValueSchema,
  findHardcodedSecrets,
  mcpServerSchema,
  packManifestSchema,
  redactSecrets,
  referencedEnvVars,
  renderEnvValue,
  workspaceManifestSchema,
  hookSchema,
  instructionSchema,
} from "../src/index.js";

describe("env values", () => {
  it("parses all three forms", () => {
    expect(envValueSchema.parse({ value: "x" })).toEqual({ value: "x" });
    expect(envValueSchema.parse({ fromEnv: "TOKEN" })).toEqual({ fromEnv: "TOKEN" });
    expect(envValueSchema.parse({ template: "Bearer ${TOKEN}", requiredEnv: ["TOKEN"] })).toEqual({
      template: "Bearer ${TOKEN}",
      requiredEnv: ["TOKEN"],
    });
  });

  it("rejects unknown fields and empty refs", () => {
    expect(envValueSchema.safeParse({ fromEnv: "" }).success).toBe(false);
    expect(envValueSchema.safeParse({ value: "x", extra: 1 }).success).toBe(false);
    expect(envValueSchema.safeParse({ template: "${A}" }).success).toBe(false);
  });

  it("collects referenced variable names", () => {
    expect(referencedEnvVars({ fromEnv: "A" })).toEqual(["A"]);
    expect(referencedEnvVars({ template: "${B}-${C}", requiredEnv: ["B", "C"] })).toEqual([
      "B",
      "C",
    ]);
    expect(referencedEnvVars({ value: "plain" })).toEqual([]);
    expect(
      collectEnvVars({ a: { fromEnv: "X" }, b: { template: "${Y}", requiredEnv: ["Y"] } }),
    ).toEqual(["X", "Y"]);
  });

  it("renders references without resolving them", () => {
    expect(renderEnvValue({ fromEnv: "TOKEN" }, (v) => `\${${v}}`)).toBe("${TOKEN}");
    expect(
      renderEnvValue({ template: "Bearer ${TOKEN}", requiredEnv: ["TOKEN"] }, (v) => `$${v}`),
    ).toBe("Bearer $TOKEN");
    expect(renderEnvValue({ value: "literal" }, (v) => `\${${v}}`)).toBe("literal");
  });
});

describe("mcp server schema", () => {
  it("requires command for stdio and url for http/sse", () => {
    expect(mcpServerSchema.safeParse({ transport: "stdio" }).success).toBe(false);
    expect(mcpServerSchema.safeParse({ transport: "stdio", command: "node" }).success).toBe(true);
    expect(mcpServerSchema.safeParse({ transport: "http" }).success).toBe(false);
    expect(mcpServerSchema.safeParse({ transport: "http", url: "https://x.invalid" }).success).toBe(
      true,
    );
    expect(mcpServerSchema.safeParse({ transport: "sse", url: "https://x.invalid" }).success).toBe(
      true,
    );
    expect(
      mcpServerSchema.safeParse({ transport: "stdio", command: "node", url: "https://x.invalid" })
        .success,
    ).toBe(false);
  });

  it("defaults enabled to true and rejects unknown fields", () => {
    const parsed = mcpServerSchema.parse({ transport: "stdio", command: "node" });
    expect(parsed.enabled).toBe(true);
    expect(
      mcpServerSchema.safeParse({ transport: "stdio", command: "node", bogus: 1 }).success,
    ).toBe(false);
  });
});

describe("hook and instruction schemas", () => {
  it("validates hooks", () => {
    expect(
      hookSchema.safeParse({ id: "h", event: "preToolUse", command: ["node", "x.mjs"] }).success,
    ).toBe(true);
    expect(hookSchema.safeParse({ id: "H!", event: "preToolUse", command: ["x"] }).success).toBe(
      false,
    );
    expect(hookSchema.safeParse({ id: "h", event: "nonsense", command: ["x"] }).success).toBe(
      false,
    );
    expect(hookSchema.safeParse({ id: "h", event: "preToolUse", command: [] }).success).toBe(false);
  });

  it("requires directory for directory scope", () => {
    const base = { id: "i", path: "./x.md" };
    expect(instructionSchema.safeParse({ ...base, scope: "directory" }).success).toBe(false);
    expect(
      instructionSchema.safeParse({ ...base, scope: "directory", directory: "src" }).success,
    ).toBe(true);
    const parsed = instructionSchema.parse(base);
    expect(parsed.scope).toBe("project");
    expect(parsed.priority).toBe(100);
    expect(parsed.mergeStrategy).toBe("managed-section");
  });
});

describe("pack manifest", () => {
  const minimal = {
    apiVersion: "agentpack.dev/v1alpha1",
    kind: "Pack",
    metadata: { name: "x", version: "0.1.0" },
    spec: {},
  };

  it("accepts a minimal pack and applies defaults", () => {
    const parsed = packManifestSchema.parse(minimal);
    expect(parsed.spec.skills).toEqual([]);
    expect(parsed.spec.mcpServers).toEqual({});
    expect(parsed.spec.hooks).toEqual([]);
  });

  it("rejects wrong apiVersion/kind and unknown top-level fields", () => {
    expect(packManifestSchema.safeParse({ ...minimal, apiVersion: "v2" }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...minimal, kind: "Workspace" }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...minimal, extra: 1 }).success).toBe(false);
  });

  it("rejects bad metadata names", () => {
    const bad = { ...minimal, metadata: { name: "Bad_Name", version: "0.1.0" } };
    expect(packManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("retains unknown fields under extensions.<target>", () => {
    const manifest = {
      ...minimal,
      spec: { extensions: { claude: { agents: [{ name: "a", anything: true }] } } },
    };
    const parsed = packManifestSchema.parse(manifest);
    expect(parsed.spec.extensions?.claude?.["agents"]).toEqual([{ name: "a", anything: true }]);
  });
});

describe("workspace manifest", () => {
  it("accepts local and git pack sources", () => {
    const manifest = {
      apiVersion: "agentpack.dev/v1alpha1",
      kind: "Workspace",
      packs: [
        { path: "./packs/a" },
        {
          source: {
            type: "git",
            url: "https://example.invalid/x.git",
            ref: "v1",
            subdirectory: "p",
          },
        },
      ],
      profiles: {
        default: { packs: ["a"], targets: ["codex", "claude", "kimi"] },
      },
    };
    const parsed = workspaceManifestSchema.parse(manifest);
    expect(parsed.profiles["default"]?.scope).toBe("project");
    expect(parsed.profiles["default"]?.installMode).toBe("auto");
  });

  it("rejects invalid profiles and unknown fields", () => {
    const base = { apiVersion: "agentpack.dev/v1alpha1", kind: "Workspace" };
    expect(
      workspaceManifestSchema.safeParse({ ...base, profiles: { p: { packs: [], targets: [] } } })
        .success,
    ).toBe(false);
    expect(
      workspaceManifestSchema.safeParse({
        ...base,
        profiles: { p: { packs: ["a"], targets: ["codex"], scope: "outer-space" } },
      }).success,
    ).toBe(false);
    expect(workspaceManifestSchema.safeParse({ ...base, nope: true }).success).toBe(false);
  });
});

describe("secret scanning and redaction", () => {
  it("finds common token patterns with line numbers, never values", () => {
    const text = 'line one\nkey = "ghp_1234567890abcdefghijklmno"\nline three';
    const findings = findHardcodedSecrets(text);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.line).toBe(2);
    expect(JSON.stringify(findings)).not.toContain("ghp_");
  });

  it("redacts secret-looking values from arbitrary text", () => {
    const out = redactSecrets("token: sk-abcdefghijklmnop1234 and AKIA1234567890ABCDEF done");
    expect(out).not.toContain("sk-abcdef");
    expect(out).not.toContain("AKIA");
    expect(out).toContain("[REDACTED]");
  });

  it("does not flag ordinary prose", () => {
    expect(findHardcodedSecrets("description: review code for security issues")).toHaveLength(0);
  });
});
