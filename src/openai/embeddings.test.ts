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

  test("accepts an array of token ids", () => {
    const result = embeddingsRequestSchema.parse({
      model: "model",
      input: [1, 2, 3],
    });
    expect(result.input).toEqual([1, 2, 3]);
  });

  test("accepts an array of token id arrays", () => {
    const result = embeddingsRequestSchema.parse({
      model: "model",
      input: [
        [1, 2],
        [3],
      ],
    });
    expect(result.input).toEqual([[1, 2], [3]]);
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

  test("rejects an empty token id array", () => {
    expect(() =>
      embeddingsRequestSchema.parse({
        model: "model",
        input: [],
      }),
    ).toThrow();
  });

  test("rejects an array containing an empty token id array", () => {
    expect(() =>
      embeddingsRequestSchema.parse({
        model: "model",
        input: [[1], []],
      }),
    ).toThrow();
  });

  test("rejects fractional or negative token ids", () => {
    expect(() =>
      embeddingsRequestSchema.parse({
        model: "model",
        input: [1.5],
      }),
    ).toThrow();
    expect(() =>
      embeddingsRequestSchema.parse({
        model: "model",
        input: [-1],
      }),
    ).toThrow();
  });
});
