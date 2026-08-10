import { describe, expect, test } from "bun:test";
import { Router, type TimeoutConfigurableServer } from "../../router.ts";
import type { EmbeddingsService } from "../../services/embeddings.ts";
import type { EmbeddingsList, EmbeddingsRequest } from "../../openai/embeddings.ts";
import type { ErrorBody } from "../../openai/error.ts";
import { embeddingsHandler } from "./embeddings.ts";

class FakeEmbeddingsService implements EmbeddingsService {
  request: EmbeddingsRequest | undefined;

  constructor(
    private readonly result: () => Promise<EmbeddingsList> | EmbeddingsList,
    readonly modelName: string = "test-model",
  ) {}

  async create(request: EmbeddingsRequest): Promise<EmbeddingsList> {
    this.request = request;
    return this.result();
  }

  async preload(): Promise<void> {}
}

function handle(
  request: Request,
  service: EmbeddingsService,
  server: TimeoutConfigurableServer = { timeout: () => {} },
): Promise<Response> {
  const router = new Router();
  router.register("POST", "/v1/embeddings", embeddingsHandler(service));
  return router.handle(request, server);
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

  test("returns 200 with the embeddings list and disables the request timeout", async () => {
    const timeouts: number[] = [];
    const server: TimeoutConfigurableServer = {
      timeout: (_request, seconds) => timeouts.push(seconds),
    };
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
      server,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(mockOutput);
    expect(timeouts).toEqual([0]);
    expect(service.request).toEqual({
      model: "test-model",
      input: "hello",
      encoding_format: "float",
    });
  });
});
