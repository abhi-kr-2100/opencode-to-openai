import { describe, expect, it } from "bun:test";
import { renderFormatSection } from "./format.ts";

describe("renderFormatSection", () => {
  it("returns undefined when response_format is undefined or text", () => {
    expect(renderFormatSection(undefined)).toBeUndefined();
    expect(renderFormatSection({ type: "text" })).toBeUndefined();
  });

  it("renders instructions for json_object", () => {
    const section = renderFormatSection({ type: "json_object" });
    expect(section).toContain("You must respond with a valid JSON object.");
    expect(section).toContain("Do not include any markdown formatting");
  });

  it("renders instructions for json_schema", () => {
    const section = renderFormatSection({
      type: "json_schema",
      json_schema: {
        name: "person_schema",
        description: "A schema for a person",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["name", "age"],
        },
      },
    });

    expect(section).toContain(
      "You must respond with a valid JSON object matching the required JSON Schema.",
    );
    expect(section).toContain("Schema Name: person_schema");
    expect(section).toContain("Schema Description: A schema for a person");
    expect(section).toContain('"type": "object"');
    expect(section).toContain('"name": {\n      "type": "string"\n    }');
  });
});
