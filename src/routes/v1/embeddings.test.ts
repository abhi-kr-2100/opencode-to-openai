import { describe, expect, test } from "bun:test";
import { Router } from "../../router.ts";
import type { EmbeddingsService } from "../../services/embeddings.ts";
import type { EmbeddingsList } from "../../openai/embeddings.ts";
import type { ErrorBody } from "../../openai/error.ts";
import { embeddingsHandler } from "./embeddings.ts";

class FakeEmbeddingsService implements EmbeddingsService {
  constructor(
    private readonly result: () => Promise<EmbeddingsList> | EmbeddingsList,
    readonly modelName: string = "test-model",
  ) {}

  async create(): Promise<EmbeddingsList> {
    return this.result();
  }

  async preload(): Promise<void> {}
}

function handle(request: Request, service: EmbeddingsService): Promise<Response> {
  const router = new Router();
  router.register("POST", "/v1/embeddings", embeddingsHandler(service));
  return router.handle(request, { timeout: () => {} });
}

describe("POST /v1/embeddings route", () => {
  test("returns 400 for an invalid JSON body", async () => {
    const service = new FakeEmbeddingsService(() => {
      throw new Error("should not be called");
    });
    const response = await handle(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        body: "{",
      }),
      service,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "the request body is not valid JSON",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
  });

  test("returns 400 when model or input are missing", async () => {
    const service = new FakeEmbeddingsService(() => {
      throw new Error("should not be called");
    });
    const response = await handle(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        body: JSON.stringify({
          encoding_format: "float",
        }),
      }),
      service,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.message).toContain("model");
    expect(body.error.message).toContain("input");
  });

  test("returns 400 when the request model does not match the configured model", async () => {
    const service = new FakeEmbeddingsService(() => {
      throw new Error("should not be called");
    }, "Xenova/bge-small-en-v1.5");
    const response = await handle(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "hello",
        }),
      }),
      service,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.message).toContain("text-embedding-3-small");
    expect(body.error.message).toContain("Xenova/bge-small-en-v1.5");
  });

  test("returns 200 with the embeddings list", async () => {
    const mockOutput: EmbeddingsList = {
      object: "list",
      data: [
        {
          object: "embedding",
          index: 0,
          embedding: [0.1, 0.2, 0.3],
        },
      ],
      model: "test-model",
      usage: {
        prompt_tokens: 5,
        total_tokens: 5,
      },
    };

    const service = new FakeEmbeddingsService(() => mockOutput);
    const response = await handle(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        body: JSON.stringify({
          model: "test-model",
          input: "hello",
        }),
      }),
      service,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(mockOutput);
  });
});
