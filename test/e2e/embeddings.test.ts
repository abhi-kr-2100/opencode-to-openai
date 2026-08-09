import { describe, expect, test } from "bun:test";
import { LocalEmbeddingsService } from "../../src/services/embeddings.ts";
import { startServer } from "./support/server.ts";
import { postJson } from "./support/requests.ts";
import type { EmbeddingList } from "../../src/openai/embeddings.ts";

describe("e2e POST /v1/embeddings", () => {
  function proxyBaseUrl(): string {
    const embeddings = new LocalEmbeddingsService("Xenova/bge-small-en-v1.5", false);
    // startServer is registered for auto cleanup in afterEach
    const proxy = startServer({
      chatCompletions: {} as any, // not used in embeddings tests
      embeddings,
    });
    return proxy.baseUrl;
  }

  test(
    "serves float embeddings by default",
    async () => {
      const baseUrl = proxyBaseUrl();
      const response = await fetch(`${baseUrl}/v1/embeddings`, postJson({
        model: "Xenova/bge-small-en-v1.5",
        input: ["hello world", "test"],
      }));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const body = (await response.json()) as EmbeddingList;
      expect(body.object).toBe("list");
      expect(body.model).toBe("Xenova/bge-small-en-v1.5");
      expect(body.data.length).toBe(2);

      expect(body.data[0].index).toBe(0);
      expect(Array.isArray(body.data[0].embedding)).toBe(true);
      const emb0 = body.data[0].embedding as number[];
      expect(emb0.length).toBe(384);

      // Verify the embedding has unit length (L2 normalized)
      let sumSq0 = 0;
      for (const val of emb0) sumSq0 += val * val;
      expect(sumSq0).toBeCloseTo(1.0, 4);

      expect(body.data[1].index).toBe(1);
      const emb1 = body.data[1].embedding as number[];
      expect(emb1.length).toBe(384);

      // Prompt tokens count must be positive
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    },
    { timeout: 60_000 },
  );

  test(
    "serves base64 encoded embeddings",
    async () => {
      const baseUrl = proxyBaseUrl();
      const response = await fetch(`${baseUrl}/v1/embeddings`, postJson({
        model: "Xenova/bge-small-en-v1.5",
        input: "hello base64",
        encoding_format: "base64",
      }));

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmbeddingList;
      expect(body.data.length).toBe(1);

      const b64 = body.data[0].embedding as string;
      expect(typeof b64).toBe("string");

      // Verify we can decode it back to Float32Array of length 384
      const buf = Buffer.from(b64, "base64");
      const floatArray = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      expect(floatArray.length).toBe(384);

      let sumSq = 0;
      for (const val of floatArray) sumSq += val * val;
      expect(sumSq).toBeCloseTo(1.0, 4);
    },
    { timeout: 60_000 },
  );

  test(
    "serves truncated embeddings with dimensions parameter",
    async () => {
      const baseUrl = proxyBaseUrl();
      const response = await fetch(`${baseUrl}/v1/embeddings`, postJson({
        model: "Xenova/bge-small-en-v1.5",
        input: "truncated",
        dimensions: 128,
      }));

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmbeddingList;
      expect(body.data[0].embedding.length).toBe(128);

      // Verify re-normalized to unit L2 length
      const emb = body.data[0].embedding as number[];
      let sumSq = 0;
      for (const val of emb) sumSq += val * val;
      expect(sumSq).toBeCloseTo(1.0, 4);
    },
    { timeout: 60_000 },
  );
});
