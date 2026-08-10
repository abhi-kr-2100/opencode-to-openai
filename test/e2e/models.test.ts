import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createOpencodeHttpClient } from "../../src/opencode/client.ts";
import { OpencodeModelsService } from "../../src/services/opencode/models.ts";
import { E2E_MODEL, startOpencode, type TestOpencode } from "./support/opencode.ts";
import { startServer, stubChatCompletions, stubEmbeddings } from "./support/server.ts";

describe("e2e GET /v1/models (real opencode server)", () => {
  let opencode: TestOpencode;

  beforeAll(async () => {
    opencode = await startOpencode();
  }, 30_000);

  afterAll(() => {
    opencode.close();
  });

  function proxyBaseUrl(): string {
    const proxy = startServer({
      chatCompletions: stubChatCompletions,
      models: new OpencodeModelsService(createOpencodeHttpClient(opencode.url)),
      embeddings: stubEmbeddings,
    });
    return proxy.baseUrl;
  }

  test("serves the model list from the real opencode server", async () => {
    const response = await fetch(`${proxyBaseUrl()}/v1/models`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const e2eModel = body.data.find((model) => model.id === E2E_MODEL);
    expect(e2eModel).toBeDefined();
    expect(e2eModel?.object).toBe("model");
  });

  test("returns 502 when the opencode server is unreachable", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("gone") });
    const deadUrl = `http://127.0.0.1:${dead.port}`;
    dead.stop();
    const baseUrl = startServer({
      chatCompletions: stubChatCompletions,
      models: new OpencodeModelsService(createOpencodeHttpClient(deadUrl)),
      embeddings: stubEmbeddings,
    }).baseUrl;

    const response = await fetch(`${baseUrl}/v1/models`);

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});
