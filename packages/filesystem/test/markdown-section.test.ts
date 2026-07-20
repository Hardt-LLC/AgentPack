import { describe, expect, it } from "vitest";

import {
  listManagedSections,
  removeManagedSection,
  sectionContent,
  upsertManagedSection,
} from "../src/index.js";

describe("upsertManagedSection", () => {
  it("appends a section to an empty file", () => {
    const out = upsertManagedSection(undefined, "rules", "Be nice.");
    expect(out).toBe("<!-- agentpack:begin rules -->\nBe nice.\n<!-- agentpack:end rules -->\n");
  });

  it("preserves existing user content", () => {
    const existing = "# My notes\n\nUser content here.\n";
    const out = upsertManagedSection(existing, "rules", "Be nice.");
    expect(out.startsWith("# My notes\n\nUser content here.\n")).toBe(true);
    expect(out).toContain("<!-- agentpack:begin rules -->");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("replaces an existing section without duplicating", () => {
    const once = upsertManagedSection(undefined, "rules", "v1");
    const twice = upsertManagedSection(once, "rules", "v2");
    expect(twice).toBe("<!-- agentpack:begin rules -->\nv2\n<!-- agentpack:end rules -->\n");
    expect(twice.match(/agentpack:begin rules/g)).toHaveLength(1);
  });

  it("is idempotent", () => {
    const once = upsertManagedSection("# Title\n", "rules", "body");
    expect(upsertManagedSection(once, "rules", "body")).toBe(once);
  });

  it("keeps other sections intact", () => {
    let doc = upsertManagedSection(undefined, "one", "first");
    doc = upsertManagedSection(doc, "two", "second");
    doc = upsertManagedSection(doc, "one", "first-updated");
    expect(listManagedSections(doc)).toEqual(["one", "two"]);
    expect(sectionContent(doc, "one")).toBe("first-updated");
    expect(sectionContent(doc, "two")).toBe("second");
  });

  it("rejects invalid section ids", () => {
    expect(() => upsertManagedSection(undefined, "Bad Id", "x")).toThrow(/invalid section id/);
    expect(() => upsertManagedSection(undefined, "-leading", "x")).toThrow(/invalid section id/);
  });
});

describe("removeManagedSection", () => {
  it("removes a section and collapses blank lines", () => {
    let doc = upsertManagedSection("# Title\n\nSome text.\n", "rules", "body");
    doc = removeManagedSection(doc, "rules");
    expect(doc).toBe("# Title\n\nSome text.\n");
  });

  it("removes a middle section cleanly", () => {
    let doc = upsertManagedSection(undefined, "one", "1");
    doc = upsertManagedSection(doc, "two", "2");
    doc = upsertManagedSection(doc, "three", "3");
    doc = removeManagedSection(doc, "two");
    expect(listManagedSections(doc)).toEqual(["one", "three"]);
    expect(doc).not.toContain("\n\n\n");
  });

  it("is a no-op for a missing section", () => {
    const doc = "# Title\n";
    expect(removeManagedSection(doc, "nope")).toBe(doc);
  });
});

describe("listManagedSections / sectionContent", () => {
  it("lists ids in document order", () => {
    let doc = upsertManagedSection(undefined, "beta", "b");
    doc = upsertManagedSection(doc, "alpha", "a");
    expect(listManagedSections(doc)).toEqual(["beta", "alpha"]);
  });

  it("returns section bodies", () => {
    const doc = upsertManagedSection(undefined, "rules", "line1\nline2");
    expect(sectionContent(doc, "rules")).toBe("line1\nline2");
    expect(sectionContent(doc, "missing")).toBeUndefined();
  });
});
