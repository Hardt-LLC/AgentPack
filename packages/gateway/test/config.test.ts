import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayConfigError, loadGatewayConfig, resolveEnvTemplates } from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentpack-gateway-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: unknown): Promise<string> {
  const path = join(dir, "gateway.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("loadGatewayConfig", () => {
  it("loads a valid config and applies defaults", async () => {
    const path = await writeConfig({
      version: 1,
      servers: {
        codegraph: { transport: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
        context7: {
          transport: "http",
          url: "https://mcp.context7.com/mcp",
          headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
          startupTimeoutMs: 5000,
        },
      },
    });
    const config = await loadGatewayConfig(path);
    expect(config.version).toBe(1);
    const codegraph = config.servers["codegraph"];
    expect(codegraph?.command).toBe("codegraph");
    expect(codegraph?.args).toEqual(["serve", "--mcp"]);
    expect(codegraph?.startupTimeoutMs).toBe(10_000);
    expect(codegraph?.toolTimeoutMs).toBe(60_000);
    const context7 = config.servers["context7"];
    expect(context7?.transport).toBe("http");
    expect(context7?.headers).toEqual({ CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" });
    expect(context7?.startupTimeoutMs).toBe(5000);
  });

  it("throws a clear error for a missing file", async () => {
    await expect(loadGatewayConfig(join(dir, "nope.json"))).rejects.toThrow(GatewayConfigError);
    await expect(loadGatewayConfig(join(dir, "nope.json"))).rejects.toThrow(
      /cannot read gateway config/,
    );
  });

  it("throws for invalid JSON", async () => {
    const path = await writeConfig("{ not json");
    await expect(loadGatewayConfig(path)).rejects.toThrow(/invalid JSON/);
  });

  it("throws for a bad server name", async () => {
    const path = await writeConfig({
      version: 1,
      servers: { Bad_Name: { transport: "stdio", command: "x" } },
    });
    await expect(loadGatewayConfig(path)).rejects.toThrow(/invalid server name "Bad_Name"/);
  });

  it("throws when stdio has no command or http has no url", async () => {
    const noCommand = await writeConfig({ version: 1, servers: { a: { transport: "stdio" } } });
    await expect(loadGatewayConfig(noCommand)).rejects.toThrow(/requires "command"/);
    const noUrl = await writeConfig({ version: 1, servers: { a: { transport: "http" } } });
    await expect(loadGatewayConfig(noUrl)).rejects.toThrow(/requires "url"/);
  });

  it("throws for an unsupported version", async () => {
    const path = await writeConfig({ version: 2, servers: {} });
    await expect(loadGatewayConfig(path)).rejects.toThrow(/"version" must be 1/);
  });
});

describe("resolveEnvTemplates", () => {
  it("resolves ${VAR} placeholders from the given environment", () => {
    const { resolved, missing } = resolveEnvTemplates(
      { KEY: "literal", SECRET: "prefix-${AGENTPACK_TEST_RESOLVE}-suffix" },
      { AGENTPACK_TEST_RESOLVE: "value" },
    );
    expect(resolved).toEqual({ KEY: "literal", SECRET: "prefix-value-suffix" });
    expect(missing).toEqual([]);
  });

  it("reports missing variables instead of throwing", () => {
    const { resolved, missing } = resolveEnvTemplates({ SECRET: "${NOPE_MISSING_VAR}" }, {});
    expect(resolved).toEqual({ SECRET: "" });
    expect(missing).toEqual(["NOPE_MISSING_VAR"]);
  });
});
