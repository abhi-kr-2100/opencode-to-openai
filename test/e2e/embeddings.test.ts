import { beforeAll, describe, expect, test } from "bun:test";
import type { EmbeddingsList } from "../../src/openai/embeddings.ts";
import { HuggingFaceEmbeddingsService } from "../../src/services/embeddings.ts";
import { startServer, stubChatCompletions, stubModels } from "./support/server.ts";
import { postJson } from "./support/requests.ts";

/**
 * The real embedding model downloaded from Hugging Face Hub on first run.
 * Override with E2E_EMBEDDINGS_MODEL to test against a different model,
 * and with E2E_EMBEDDINGS_DIMENSIONS to match that model's output size.
 */
const EMBEDDING_MODEL = process.env.E2E_EMBEDDINGS_MODEL ?? "Xenova/bge-small-en-v1.5";
// Must match the model above; override along with E2E_EMBEDDINGS_MODEL.
const EMBEDDING_DIMENSIONS = Number(process.env.E2E_EMBEDDINGS_DIMENSIONS ?? 384);

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(normA * normB);
}

describe("e2e POST /v1/embeddings (real HuggingFace model)", () => {
  let embeddings: HuggingFaceEmbeddingsService;

  beforeAll(async () => {
    embeddings = new HuggingFaceEmbeddingsService(EMBEDDING_MODEL);
    await embeddings.preload();
  }, 180_000);

  function proxyBaseUrl(): string {
    return startServer({
      chatCompletions: stubChatCompletions,
      models: stubModels,
      embeddings,
    }).baseUrl;
  }

  async function embed(input: string | string[]): Promise<number[][]> {
    const response = await fetch(
      `${proxyBaseUrl()}/v1/embeddings`,
      postJson({ model: EMBEDDING_MODEL, input }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as EmbeddingsList;
    expect(body.object).toBe("list");
    expect(body.model).toBe(EMBEDDING_MODEL);
    return body.data.map((item) => item.embedding as number[]);
  }

  test("serves real embeddings for a single string input", async () => {
    const response = await fetch(
      `${proxyBaseUrl()}/v1/embeddings`,
      postJson({ model: EMBEDDING_MODEL, input: "hello world" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as EmbeddingsList;
    expect(body.object).toBe("list");
    expect(body.model).toBe(EMBEDDING_MODEL);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.index).toBe(0);
    expect(body.data[0]!.object).toBe("embedding");

    const vector = body.data[0]!.embedding as number[];
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vector.every((value) => Number.isFinite(value))).toBe(true);

    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens);
  });

  test("serves real embeddings for batched array inputs", async () => {
    const response = await fetch(
      `${proxyBaseUrl()}/v1/embeddings`,
      postJson({ model: EMBEDDING_MODEL, input: ["foo", "bar baz"] }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as EmbeddingsList;
    expect(body.data).toHaveLength(2);
    expect(body.data[0]!.index).toBe(0);
    expect(body.data[1]!.index).toBe(1);
    for (const item of body.data) {
      const vector = item.embedding as number[];
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(vector.every((value) => Number.isFinite(value))).toBe(true);
    }
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens);
  });

  test("embeds deterministically and ranks similar texts closer than unrelated ones", async () => {
    const similar = "the quick brown fox jumps over the lazy dog";
    const nearDuplicate = "a quick brown fox leaps over the sleeping dog";
    const unrelated = "quantum chromodynamics in lattice gauge theory";

    const [first, second] = await Promise.all([embed(similar), embed(similar)]);
    expect(first[0]!).toEqual(second[0]!);

    const [fox, sleeping, quantum] = (await embed([similar, nearDuplicate, unrelated])) as [
      number[],
      number[],
      number[],
    ];
    const similarCosine = cosineSimilarity(fox, sleeping);
    const unrelatedCosine = cosineSimilarity(fox, quantum);
    expect(similarCosine).toBeGreaterThan(0.5);
    expect(unrelatedCosine).toBeLessThan(0.5);
    expect(similarCosine).toBeGreaterThan(unrelatedCosine);
  });

  test("truncates and re-normalizes to requested dimensions", async () => {
    const response = await fetch(
      `${proxyBaseUrl()}/v1/embeddings`,
      postJson({ model: EMBEDDING_MODEL, input: "l2 normalized", dimensions: 2 }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as EmbeddingsList;
    const vec = body.data[0]!.embedding as number[];
    expect(vec).toHaveLength(2);
    const magnitude = Math.hypot(vec[0]!, vec[1]!);
    expect(magnitude).toBeCloseTo(1, 3);
  });

  test("supports base64 encoding format", async () => {
    const response = await fetch(
      `${proxyBaseUrl()}/v1/embeddings`,
      postJson({ model: EMBEDDING_MODEL, input: "base64 output", encoding_format: "base64" }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as EmbeddingsList;
    expect(typeof body.data[0]!.embedding).toBe("string");
    const buffer = Buffer.from(body.data[0]!.embedding as string, "base64");
    const arr = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
    expect(arr.length).toBe(EMBEDDING_DIMENSIONS);
    expect(Array.from(arr).every((value) => Number.isFinite(value))).toBe(true);
  });
});
