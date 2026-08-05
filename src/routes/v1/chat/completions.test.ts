import { describe, expect, test } from "bun:test";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "../../../openai/chat-completions.ts";
import { Router, type TimeoutConfigurableServer } from "../../../router.ts";
import type {
  ChatCompletionsService,
  ChatCompletionResult,
} from "../../../services/chat-completions.ts";
import { chatCompletionsHandler } from "./completions.ts";

const stubServer: TimeoutConfigurableServer = { timeout: () => {} };

class FakeChatCompletionsService implements ChatCompletionsService {
  constructor(private readonly result: (request: ChatCompletionRequest) => ChatCompletionResult) {}

  async create(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.result(request);
  }
}

interface ErrorBody {
  error: { type?: string; code?: string | null };
}

async function readError(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

function createRouter(): Router {
  const router = new Router();
  router.register(
    "POST",
    "/v1/chat/completions",
    chatCompletionsHandler(
      new FakeChatCompletionsService(() => {
        throw new Error("unreachable in validation tests");
      }),
    ),
  );
  return router;
}

function handle(request: Request): Promise<Response> {
  return createRouter().handle(request, stubServer);
}

function postJson(body: unknown): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/chat/completions", () => {
  test("returns 400 for an invalid JSON body", async () => {
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: "not json",
    });
    const response = await handle(request);
    expect(response.status).toBe(400);
    const body = await readError(response);
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("returns 400 when messages are missing", async () => {
    const response = await handle(postJson({ model: "gpt-4o" }));
    expect(response.status).toBe(400);
  });

  test("returns 404 for an unknown route", async () => {
    const response = await handle(
      new Request("http://localhost/v1/embeddings", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });

  test("returns 405 for a wrong method", async () => {
    const response = await handle(new Request("http://localhost/v1/chat/completions"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("returns a JSON completion for a non-streaming request", async () => {
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
    const router = new Router();
    router.register(
      "POST",
      "/v1/chat/completions",
      chatCompletionsHandler(
        new FakeChatCompletionsService(() => ({ stream: false, value: completion })),
      ),
    );
    const response = await router.handle(
      postJson({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      stubServer,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(completion);
  });

  test("returns an SSE stream and disables the timeout for streaming requests", async () => {
    const timeouts: number[] = [];
    const server: TimeoutConfigurableServer = { timeout: (_request, seconds) => timeouts.push(seconds) };
    const router = new Router();
    router.register(
      "POST",
      "/v1/chat/completions",
      chatCompletionsHandler(
        new FakeChatCompletionsService(() => ({
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
      ),
    );
    const response = await router.handle(
      postJson({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      server,
    );
    expect(timeouts).toEqual([0]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  });
});
