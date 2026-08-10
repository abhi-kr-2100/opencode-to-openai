import { describe, expect, test } from "bun:test";
import { postJson } from "./requests.ts";
import { startServer, stubChatCompletions, stubEmbeddings, stubModels } from "./server.ts";

describe("startServer service stubs", () => {
  test("fails loudly when an unexpected service is exercised", async () => {
    const server = startServer({
      chatCompletions: stubChatCompletions,
      models: stubModels,
      embeddings: stubEmbeddings,
    });
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const chatResponse = await fetch(
      `${server.baseUrl}/v1/chat/completions`,
      postJson({ model: "stub", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(chatResponse.status).toBe(500);

    const modelsResponse = await fetch(`${server.baseUrl}/v1/models`);
    expect(modelsResponse.status).toBe(500);
  });

  test("fails loudly when the embeddings service is exercised", async () => {
    const server = startServer({
      chatCompletions: stubChatCompletions,
      models: stubModels,
      embeddings: stubEmbeddings,
    });
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const embeddingsResponse = await fetch(
      `${server.baseUrl}/v1/embeddings`,
      postJson({ model: "Xenova/bge-small-en-v1.5", input: "hi" }),
    );
    expect(embeddingsResponse.status).toBe(500);
  });

  test("stubEmbeddings.preload() resolves without errors", async () => {
    await stubEmbeddings.preload();
  });
});
