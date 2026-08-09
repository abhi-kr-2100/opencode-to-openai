import { describe, expect, test } from "bun:test";
import { postJson } from "./requests.ts";
import { startServer, stubChatCompletions, stubModels } from "./server.ts";

describe("startServer service stubs", () => {
  test("fails loudly when an unexpected service is exercised", async () => {
    const server = startServer({ chatCompletions: stubChatCompletions, models: stubModels });
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const chatResponse = await fetch(
      `${server.baseUrl}/v1/chat/completions`,
      postJson({ model: "stub", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(chatResponse.status).toBe(500);

    const modelsResponse = await fetch(`${server.baseUrl}/v1/models`);
    expect(modelsResponse.status).toBe(500);
  });
});
