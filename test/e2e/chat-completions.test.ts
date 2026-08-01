import { describe, expect, test } from "bun:test";
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from "../../src/openai/chat-completions.ts";
import { postJson } from "./support/requests.ts";
import { startServer } from "./support/server.ts";
import { FakeChatCompletionsService } from "./support/services.ts";

describe("e2e POST /v1/chat/completions", () => {
  test("returns 501 from the stub backend, matching the real entrypoint wiring", async () => {
    const { baseUrl } = startServer();
    const response = await fetch(
      `${baseUrl}/v1/chat/completions`,
      postJson({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(501);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as { error: { code: string | null } };
    expect(body.error.code).toBe("not_implemented");
  });

  test("rejects an invalid JSON body with 400", async () => {
    const { baseUrl } = startServer();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: "not json",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("rejects a request without messages with 400", async () => {
    const { baseUrl } = startServer();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, postJson({ model: "gpt-4o" }));
    expect(response.status).toBe(400);
  });

  test("returns 405 for a wrong method", async () => {
    const { baseUrl } = startServer();
    const response = await fetch(`${baseUrl}/v1/chat/completions`);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("returns 404 for an unknown route", async () => {
    const { baseUrl } = startServer();
    const response = await fetch(`${baseUrl}/v1/embeddings`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("serves a non-streaming completion over HTTP", async () => {
    const completion: ChatCompletion = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const { baseUrl } = startServer({
      chatCompletions: new FakeChatCompletionsService(() => ({
        stream: false,
        value: completion,
      })),
    });
    const response = await fetch(
      `${baseUrl}/v1/chat/completions`,
      postJson({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(completion);
  });

  test("streams SSE chunks over HTTP", async () => {
    const { baseUrl } = startServer({
      chatCompletions: new FakeChatCompletionsService(() => ({
        stream: true,
        value: (async function* (): AsyncGenerator<ChatCompletionChunk> {
          yield {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [
              { index: 0, delta: { content: "hi" }, finish_reason: null, logprobs: null },
            ],
          };
        })(),
      })),
    });
    const response = await fetch(
      `${baseUrl}/v1/chat/completions`,
      postJson({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  });
});
