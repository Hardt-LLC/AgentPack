import { describe, expect, it } from "vitest";

import { getJsonAtPointer, mergeJsonAtPointer, removeJsonAtPointer } from "../src/index.js";

describe("mergeJsonAtPointer", () => {
  it("creates a document from nothing", () => {
    const out = mergeJsonAtPointer(undefined, "/mcpServers/github", { command: "gh" });
    expect(JSON.parse(out)).toEqual({ mcpServers: { github: { command: "gh" } } });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("treats empty input as an empty object", () => {
    const out = mergeJsonAtPointer("", "/a", 1);
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("preserves unknown keys and sibling servers", () => {
    const existing = JSON.stringify({
      mcpServers: { linear: { command: "linear" }, github: { old: true } },
      other: { keep: "me" },
    });
    const out = mergeJsonAtPointer(existing, "/mcpServers/github", { command: "gh" });
    expect(JSON.parse(out)).toEqual({
      mcpServers: { linear: { command: "linear" }, github: { command: "gh" } },
      other: { keep: "me" },
    });
  });

  it("is idempotent", () => {
    const once = mergeJsonAtPointer(undefined, "/a/b", { x: 1 });
    expect(mergeJsonAtPointer(once, "/a/b", { x: 1 })).toBe(once);
  });

  it("replaces the value at the key", () => {
    const existing = JSON.stringify({ a: { b: { old: true } } });
    const out = mergeJsonAtPointer(existing, "/a/b", { fresh: 1 });
    expect(JSON.parse(out)).toEqual({ a: { b: { fresh: 1 } } });
  });

  it("throws on invalid JSON", () => {
    expect(() => mergeJsonAtPointer("{nope", "/a", 1)).toThrow(/invalid JSON/);
  });

  it("throws when a segment traverses a non-object", () => {
    const existing = JSON.stringify({ a: 5 });
    expect(() => mergeJsonAtPointer(existing, "/a/b", 1)).toThrow(/non-object/);
  });
});

describe("removeJsonAtPointer", () => {
  it("removes the key and cleans up empty parents", () => {
    const existing = JSON.stringify({ a: { b: { c: 1 } }, keep: true });
    const out = removeJsonAtPointer(existing, "/a/b/c");
    expect(JSON.parse(out)).toEqual({ keep: true });
  });

  it("keeps non-empty parents", () => {
    const existing = JSON.stringify({ a: { b: { c: 1, d: 2 } } });
    const out = removeJsonAtPointer(existing, "/a/b/c");
    expect(JSON.parse(out)).toEqual({ a: { b: { d: 2 } } });
  });

  it("is a no-op for absent keys", () => {
    const existing = JSON.stringify({ a: 1 }, null, 2);
    expect(JSON.parse(removeJsonAtPointer(existing, "/b/c"))).toEqual({ a: 1 });
  });

  it("throws on invalid JSON", () => {
    expect(() => removeJsonAtPointer("not json", "/a")).toThrow(/invalid JSON/);
  });
});

describe("getJsonAtPointer", () => {
  it("returns the value or undefined", () => {
    const existing = JSON.stringify({ a: { b: { c: 42 } } });
    expect(getJsonAtPointer(existing, "/a/b/c")).toBe(42);
    expect(getJsonAtPointer(existing, "/a/b/missing")).toBeUndefined();
    expect(getJsonAtPointer(existing, "/a/b/c/deeper")).toBeUndefined();
  });
});
