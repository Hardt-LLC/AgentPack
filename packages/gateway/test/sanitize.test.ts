import { describe, expect, it } from "vitest";
import { aggregateTools } from "../src/aggregate.js";
import { sanitizeSchema } from "../src/sanitize.js";

describe("sanitizeSchema", () => {
  it("strips x- extension keywords recursively", () => {
    const schema = {
      type: "object",
      "x-google-identifier": "id",
      properties: {
        mode: { type: "string", "x-google-enum-descriptions": ["a", "b"] },
      },
      $defs: {
        Inner: { type: "object", "x-google-enum-deprecated": [true] },
      },
      items: [{ "x-anything": 1, type: "string" }],
    };
    const clean = sanitizeSchema(schema) as Record<string, unknown>;
    expect(clean["x-google-identifier"]).toBeUndefined();
    expect(
      (clean["properties"] as Record<string, Record<string, unknown>>)["mode"]?.[
        "x-google-enum-descriptions"
      ],
    ).toBeUndefined();
    expect(
      (clean["$defs"] as Record<string, Record<string, unknown>>)["Inner"]?.[
        "x-google-enum-deprecated"
      ],
    ).toBeUndefined();
    expect((clean["items"] as Array<Record<string, unknown>>)[0]?.["x-anything"]).toBeUndefined();
    // Standard keywords untouched.
    expect(clean["type"]).toBe("object");
    expect(clean["$defs"]).toBeDefined();
  });

  it("passes through primitives and arrays unchanged", () => {
    expect(sanitizeSchema("x-string")).toBe("x-string");
    expect(sanitizeSchema(42)).toBe(42);
    expect(sanitizeSchema(null)).toBe(null);
    expect(sanitizeSchema([1, "x-2"])).toEqual([1, "x-2"]);
  });

  it("drops non-standard formats but keeps standard ones", () => {
    const clean = sanitizeSchema({
      type: "object",
      properties: {
        count: { type: "integer", format: "int32" },
        when: { type: "string", format: "date-time" },
      },
    }) as unknown as { properties: Record<string, Record<string, unknown>> };
    expect(clean.properties["count"]?.["format"]).toBeUndefined();
    expect(clean.properties["count"]?.["type"]).toBe("integer");
    expect(clean.properties["when"]?.["format"]).toBe("date-time");
  });

  it("repairs dangling root-local $refs and keeps valid ones", () => {
    const clean = sanitizeSchema({
      type: "object",
      properties: {
        broken: { $ref: "#/$defs/ScreenInstance" },
        works: { $ref: "#/$defs/Real" },
        external: { $ref: "https://example.com/schema.json#/$defs/X" },
      },
      $defs: { Real: { type: "string" } },
    }) as unknown as {
      properties: Record<string, unknown>;
    };
    // Lone dangling $ref collapses to `true`.
    expect(clean.properties["broken"]).toBe(true);
    expect(clean.properties["works"]).toEqual({ $ref: "#/$defs/Real" });
    expect(clean.properties["external"]).toEqual({
      $ref: "https://example.com/schema.json#/$defs/X",
    });
  });

  it("aggregateTools sanitizes exposed inputSchemas", () => {
    const routed = aggregateTools([
      {
        server: "stitch",
        tools: [
          {
            name: "make",
            inputSchema: { type: "object", "x-google-identifier": "x" } as Record<string, unknown>,
            outputSchema: { type: "object", "x-google-enum-deprecated": [true] } as Record<
              string,
              unknown
            >,
          },
        ],
      },
    ]);
    const tool = routed.get("stitch__make")!;
    expect(tool.exposed.inputSchema?.["x-google-identifier"]).toBeUndefined();
    expect(tool.exposed.inputSchema?.["type"]).toBe("object");
    const out = tool.exposed["outputSchema"] as Record<string, unknown>;
    expect(out["x-google-enum-deprecated"]).toBeUndefined();
    expect(out["type"]).toBe("object");
  });
});
