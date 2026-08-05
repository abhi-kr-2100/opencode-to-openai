import { describe, expect, test } from "bun:test";
import { BadRequestError } from "../../http/errors.ts";
import { parseModel } from "./model.ts";

describe("parseModel", () => {
  test("parses provider/model", () => {
    expect(parseModel("anthropic/claude-3-5-sonnet-20241022")).toEqual({
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    });
  });

  test("throws for providerless or malformed models", () => {
    expect(() => parseModel("gpt-4o")).toThrow(BadRequestError);
    expect(() => parseModel("/model")).toThrow(BadRequestError);
    expect(() => parseModel("provider/")).toThrow(BadRequestError);
  });
});
