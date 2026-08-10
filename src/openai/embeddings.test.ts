import { describe, expect, test } from "bun:test";
import { embeddingsRequestSchema } from "./embeddings.ts";

describe("embeddingsRequestSchema input validation", () => {
  test("accepts a non-empty string input", () => {
    const result = embeddingsRequestSchema.parse({
      model: "model",
      input: "hello",
    });
    expect(result.input).toBe("hello");
  });

  test("accepts a non-empty array of non-empty strings", () => {
    const result = embeddingsRequestSchema.parse({
      model: "model",
      input: ["hello", "world"],
    });
    expect(result.input).toEqual(["hello", "world"]);
  });

  test("rejects an empty string input", () => {
    expect(() =>
      embeddingsRequestSchema.parse({
        model: "model",
        input: "",
      }),
    ).toThrow();
  });

  test("rejects an empty array input", () => {
    expect(() =>
      embeddingsRequestSchema.parse({
        model: "model",
        input: [],
      }),
    ).toThrow();
  });

  test("rejects an array containing an empty string", () => {
    expect(() =>
      embeddingsRequestSchema.parse({
        model: "model",
        input: ["hello", ""],
      }),
    ).toThrow();
  });
});
