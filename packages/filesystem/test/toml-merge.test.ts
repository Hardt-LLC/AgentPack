import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import { getTomlAtTable, mergeTomlAtTable, removeTomlAtTable } from "../src/index.js";

describe("mergeTomlAtTable", () => {
  it("creates a document from nothing", () => {
    const out = mergeTomlAtTable(undefined, ["mcp_servers", "github"], { command: "gh" });
    expect(parse(out)).toEqual({ mcp_servers: { github: { command: "gh" } } });
  });

  it("preserves other tables and keys", () => {
    const existing = [
      "[mcp_servers.linear]",
      'command = "linear"',
      "",
      "[other]",
      'keep = "me"',
      "",
    ].join("\n");
    const out = mergeTomlAtTable(existing, ["mcp_servers", "github"], { command: "gh" });
    expect(parse(out)).toEqual({
      mcp_servers: { linear: { command: "linear" }, github: { command: "gh" } },
      other: { keep: "me" },
    });
  });

  it("replaces an existing table", () => {
    const existing = ["[mcp_servers.github]", 'command = "old"', ""].join("\n");
    const out = mergeTomlAtTable(existing, ["mcp_servers", "github"], { command: "new" });
    expect(parse(out)).toEqual({ mcp_servers: { github: { command: "new" } } });
  });

  it("is idempotent", () => {
    const once = mergeTomlAtTable(undefined, ["a", "b"], { x: 1 });
    expect(mergeTomlAtTable(once, ["a", "b"], { x: 1 })).toBe(once);
  });

  it("throws on invalid TOML", () => {
    expect(() => mergeTomlAtTable("[unclosed", ["a"], {})).toThrow();
  });

  it("rejects an empty table path", () => {
    expect(() => mergeTomlAtTable(undefined, [], {})).toThrow(/invalid TOML table path/);
  });
});

describe("removeTomlAtTable", () => {
  it("removes the table and cleans up empty parents", () => {
    const existing = ["[a.b]", "x = 1", "", "[keep]", 'y = "z"', ""].join("\n");
    const out = removeTomlAtTable(existing, ["a", "b"]);
    expect(parse(out)).toEqual({ keep: { y: "z" } });
  });

  it("is a no-op for absent tables", () => {
    const existing = ["[a]", "x = 1", ""].join("\n");
    expect(parse(removeTomlAtTable(existing, ["b", "c"]))).toEqual({ a: { x: 1 } });
  });
});

describe("getTomlAtTable", () => {
  it("returns the table or undefined", () => {
    const existing = ["[a.b]", "x = 1", ""].join("\n");
    expect(getTomlAtTable(existing, ["a", "b"])).toEqual({ x: 1 });
    expect(getTomlAtTable(existing, ["a", "missing"])).toBeUndefined();
  });
});
