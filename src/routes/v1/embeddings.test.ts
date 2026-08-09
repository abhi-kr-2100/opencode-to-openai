import { describe, expect, test } from "bun:test";
import { Router, type TimeoutConfigurableServer } from "../../router.ts";
import type { EmbeddingsService } from "../../services/embeddings.ts";
import type { EmbeddingsRequest, EmbeddingList } from "../../openai/embeddings.ts";
import { embeddingsHandler } from "./embeddings.ts";

const stubServer: TimeoutConfigurableServer = { timeout: () => {} };

class FakeEmbeddingsService implements EmbeddingsService {
  constructor(private readonly result: (request: EmbeddingsRequest) => EmbeddingList) {}

  async create(request: EmbeddingsRequest): Promise<EmbeddingList> {
    return this.result(request);
  }
}

interface ErrorBody {
  error: { type?: string; code?: string | null; message?: string };
}

async function readError(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

function postJson(body: unknown): Request {
  return new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/embeddings", () => {
  test("returns 400 for an invalid JSON body", async () => {
    const request = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: "not json",
    });
    const router = new Router();
    router.register(
      "POST",
      "/v1/embeddings",
      embeddingsHandler(
        new FakeEmbeddingsService(() => {
          throw new Error("unreachable");
        }),
      ),
    );
    const response = await router.handle(request, stubServer);
    expect(response.status).toBe(400);
    const body = await readError(response);
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("returns 400 when model is missing", async () => {
    const router = new Router();
    router.register(
      "POST",
      "/v1/embeddings",
      embeddingsHandler(
        new FakeEmbeddingsService(() => {
          throw new Error("unreachable");
        }),
      ),
    );
    const response = await router.handle(postJson({ input: "hello" }), stubServer);
    expect(response.status).toBe(400);
  });

  test("returns 400 when input is missing", async () => {
    const router = new Router();
    router.register(
      "POST",
      "/v1/embeddings",
      embeddingsHandler(
        new FakeEmbeddingsService(() => {
          throw new Error("unreachable");
        }),
      ),
    );
    const response = await router.handle(postJson({ model: "bge-small" }), stubServer);
    expect(response.status).toBe(400);
  });

  test("returns a JSON list of embeddings for a valid request", async () => {
    const list: EmbeddingList = {
      object: "list",
      data: [
        {
          object: "embedding",
          index: 0,
          embedding: [0.1, 0.2, 0.3],
        },
      ],
      model: "bge-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    };

    const router = new Router();
    router.register(
      "POST",
      "/v1/embeddings",
      embeddingsHandler(
        new FakeEmbeddingsService((req) => {
          expect(req.model).toBe("bge-small");
          expect(req.input).toBe("hello world");
          return list;
        }),
      ),
    );

    const response = await router.handle(
      postJson({ model: "bge-small", input: "hello world" }),
      stubServer,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(list);
  });
});
