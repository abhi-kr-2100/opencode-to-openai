import { describe, expect, test } from "bun:test";
import { Router } from "../../router.ts";
import type { EmbeddingsService } from "../../services/embeddings.ts";
import type { ModelsService } from "../../services/models.ts";
import type { ModelsList } from "../../openai/models.ts";
import { modelsHandler } from "./models.ts";

class FakeModelsService implements ModelsService {
  constructor(private readonly result: () => Promise<ModelsList> | ModelsList) {}

  async list(): Promise<ModelsList> {
    return this.result();
  }
}

class FakeEmbeddingsService implements EmbeddingsService {
  constructor(readonly modelName: string) {}

  async create(): Promise<never> {
    throw new Error("not implemented");
  }

  async preload(): Promise<void> {}
}

function handle(
  request: Request,
  service: ModelsService,
  embeddingsService?: EmbeddingsService,
): Promise<Response> {
  const router = new Router();
  router.register("GET", "/v1/models", modelsHandler(service, embeddingsService));
  return router.handle(request, { timeout: () => {} });
}

describe("GET /v1/models", () => {
  test("returns the list of models without embeddings service", async () => {
    const listResponse: ModelsList = {
      object: "list",
      data: [
        {
          id: "anthropic/claude-3-5-sonnet-20241022",
          object: "model",
          created: 1700000000,
          owned_by: "anthropic",
        },
      ],
    };

    const service = new FakeModelsService(() => listResponse);
    const response = await handle(new Request("http://localhost/v1/models"), service);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(listResponse);
  });

  test("appends the embeddings model to the models list when embeddings service is provided", async () => {
    const listResponse: ModelsList = {
      object: "list",
      data: [
        {
          id: "anthropic/claude-3-5-sonnet-20241022",
          object: "model",
          created: 1700000000,
          owned_by: "anthropic",
        },
      ],
    };

    const modelsService = new FakeModelsService(() => listResponse);
    const embeddingsService = new FakeEmbeddingsService("Xenova/bge-small-en-v1.5");
    const response = await handle(
      new Request("http://localhost/v1/models"),
      modelsService,
      embeddingsService,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "anthropic/claude-3-5-sonnet-20241022",
          object: "model",
          created: 1700000000,
          owned_by: "anthropic",
        },
        {
          id: "Xenova/bge-small-en-v1.5",
          object: "model",
          created: 1700000000,
          owned_by: "Xenova",
        },
      ],
    });
  });

  test("does not add duplicate entry if the embeddings model is already in the list", async () => {
    const listResponse: ModelsList = {
      object: "list",
      data: [
        {
          id: "Xenova/bge-small-en-v1.5",
          object: "model",
          created: 1700000000,
          owned_by: "Xenova",
        },
      ],
    };

    const modelsService = new FakeModelsService(() => listResponse);
    const embeddingsService = new FakeEmbeddingsService("Xenova/bge-small-en-v1.5");
    const response = await handle(
      new Request("http://localhost/v1/models"),
      modelsService,
      embeddingsService,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(listResponse);
  });
});
