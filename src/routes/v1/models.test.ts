import { describe, expect, test } from "bun:test";
import { Router } from "../../router.ts";
import type { ModelsService } from "../../services/models.ts";
import type { ModelsList } from "../../openai/models.ts";
import { modelsHandler } from "./models.ts";

class FakeModelsService implements ModelsService {
  constructor(private readonly result: () => Promise<ModelsList> | ModelsList) {}

  async list(): Promise<ModelsList> {
    return this.result();
  }
}

function handle(request: Request, service: ModelsService): Promise<Response> {
  const router = new Router();
  router.register("GET", "/v1/models", modelsHandler(service));
  return router.handle(request, { timeout: () => {} });
}

describe("GET /v1/models", () => {
  test("returns the list of models", async () => {
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
});
