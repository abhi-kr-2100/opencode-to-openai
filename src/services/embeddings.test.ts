import { describe, expect, test, mock } from "bun:test";

// Mock @huggingface/transformers before importing the service
mock.module("@huggingface/transformers", () => {
  return {
    pipeline: async (task: string, model: string, options: any) => {
      const mockPipeline = async (inputs: string | string[], opts: any) => {
        const arr = typeof inputs === "string" ? [inputs] : inputs;
        const count = arr.length;
        const dim = 384;
        const data = new Float32Array(count * dim);
        for (let i = 0; i < count; i++) {
          // Fill each sentence's vector with a constant pattern so they are unit L2 vectors
          // Specifically, we set all elements to 1 / sqrt(384) so the L2 norm is exactly 1.
          const val = 1.0 / Math.sqrt(dim);
          const offset = i * dim;
          for (let d = 0; d < dim; d++) {
            data[offset + d] = val;
          }
        }
        return {
          dims: [count, dim],
          data,
          type: "float32",
        };
      };
      mockPipeline.tokenizer = {
        encode: (text: string) => {
          // return an array of token IDs, matching word count
          return new Array(text.split(/\s+/).filter(Boolean).length);
        },
      };
      return mockPipeline;
    },
  };
});

import { LocalEmbeddingsService } from "./embeddings.ts";
import { embeddingsRequestSchema } from "../openai/embeddings.ts";

describe("LocalEmbeddingsService", () => {
  test("embeddingsRequestSchema validation", () => {
    // Valid request
    const valid = embeddingsRequestSchema.safeParse({
      model: "Xenova/bge-small-en-v1.5",
      input: ["hello world", "test"],
      encoding_format: "float",
      dimensions: 128,
    });
    expect(valid.success).toBe(true);

    // Invalid input type
    const invalidInput = embeddingsRequestSchema.safeParse({
      model: "Xenova/bge-small-en-v1.5",
      input: 123,
    });
    expect(invalidInput.success).toBe(false);

    // Invalid encoding_format
    const invalidFormat = embeddingsRequestSchema.safeParse({
      model: "Xenova/bge-small-en-v1.5",
      input: "test",
      encoding_format: "invalid",
    });
    expect(invalidFormat.success).toBe(false);
  });

  test("generates float embeddings correctly", async () => {
    const service = new LocalEmbeddingsService("Xenova/bge-small-en-v1.5");
    const result = await service.create({
      model: "Xenova/bge-small-en-v1.5",
      input: "hello world",
      encoding_format: "float",
    });

    expect(result.object).toBe("list");
    expect(result.model).toBe("Xenova/bge-small-en-v1.5");
    expect(result.data.length).toBe(1);
    expect(result.data[0].index).toBe(0);
    expect(result.data[0].object).toBe("embedding");

    const emb = result.data[0].embedding as number[];
    expect(emb.length).toBe(384);
    // Verify it is L2 normalized: sum of squares is approx 1
    let sumSq = 0;
    for (const v of emb) {
      sumSq += v * v;
    }
    expect(sumSq).toBeCloseTo(1.0, 5);

    // Usage tokens should match word count ("hello world" -> 2 words)
    expect(result.usage.prompt_tokens).toBe(2);
  });

  test("generates batched base64 embeddings", async () => {
    const service = new LocalEmbeddingsService("Xenova/bge-small-en-v1.5");
    const result = await service.create({
      model: "Xenova/bge-small-en-v1.5",
      input: ["hello world", "foo bar baz"],
      encoding_format: "base64",
    });

    expect(result.data.length).toBe(2);
    expect(typeof result.data[0].embedding).toBe("string");
    expect(typeof result.data[1].embedding).toBe("string");

    // Decode and verify first embedding
    const b64 = result.data[0].embedding as string;
    const buf = Buffer.from(b64, "base64");
    const floatArray = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    expect(floatArray.length).toBe(384);
    expect(floatArray[0]).toBeCloseTo(1.0 / Math.sqrt(384), 5);

    // Token counts: "hello world" (2) + "foo bar baz" (3) = 5
    expect(result.usage.prompt_tokens).toBe(5);
  });

  test("supports dimensions truncation and re-normalization", async () => {
    const service = new LocalEmbeddingsService("Xenova/bge-small-en-v1.5");
    const result = await service.create({
      model: "Xenova/bge-small-en-v1.5",
      input: "hello",
      dimensions: 100,
    });

    const emb = result.data[0].embedding as number[];
    expect(emb.length).toBe(100);

    // Re-normalized vector: sum of squares must be close to 1
    let sumSq = 0;
    for (const v of emb) {
      sumSq += v * v;
    }
    expect(sumSq).toBeCloseTo(1.0, 5);
    expect(emb[0]).toBeCloseTo(1.0 / Math.sqrt(100), 5);
  });

  test("throws error when requested dimensions exceeds model native dimensions", async () => {
    const service = new LocalEmbeddingsService("Xenova/bge-small-en-v1.5");
    expect(
      service.create({
        model: "Xenova/bge-small-en-v1.5",
        input: "hello",
        dimensions: 1000,
      }),
    ).rejects.toThrow(/cannot exceed the model's maximum/);
  });
});
