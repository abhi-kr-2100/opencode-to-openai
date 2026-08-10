import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "../../src/openai/chat-completions.ts";
import { createOpencodeHttpClient } from "../../src/opencode/client.ts";
import { OpencodeChatCompletionsService } from "../../src/services/opencode/service.ts";
import { E2E_MODEL, startOpencode, type TestOpencode } from "./support/opencode.ts";
import { postJson } from "./support/requests.ts";
import { startServer, stubEmbeddings, stubModels } from "./support/server.ts";
const PROMPT = "Reply with exactly one word: pong";

function completionBody(extra: Partial<ChatCompletionRequest> = {}): RequestInit {
  return postJson({ model: E2E_MODEL, messages: [{ role: "user", content: PROMPT }], ...extra });
}

function parseSseEvents(text: string): Array<string | ChatCompletionChunk> {
  return text
    .split("\n\n")
    .map((block) => block.match(/^data: (.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => {
      const payload = match[1]!;
      return payload === "[DONE]" ? "[DONE]" : (JSON.parse(payload) as ChatCompletionChunk);
    });
}

describe("e2e POST /v1/chat/completions (real opencode server)", () => {
  let opencode: TestOpencode;

  beforeAll(async () => {
    opencode = await startOpencode();
  }, 30_000);

  afterAll(() => {
    opencode.close();
  });

  function proxyBaseUrl(): string {
    const proxy = startServer({
      chatCompletions: new OpencodeChatCompletionsService(createOpencodeHttpClient(opencode.url)),
      models: stubModels,
      embeddings: stubEmbeddings,
    });
    return proxy.baseUrl;
  }

  test(
    "serves a completion from the real opencode server",
    async () => {
      const baseUrl = proxyBaseUrl();
      const response = await fetch(`${baseUrl}/v1/chat/completions`, completionBody());

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      const body = (await response.json()) as ChatCompletion;
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(E2E_MODEL);
      expect(body.choices[0]?.message.role).toBe("assistant");
      expect(typeof body.choices[0]?.message.content).toBe("string");
      expect(body.choices[0]?.message.content?.length).toBeGreaterThan(0);
      expect(body.choices[0]?.finish_reason).toBe("stop");
      expect(body.usage.total_tokens).toBeGreaterThan(0);
    },
    { timeout: 60_000 },
  );

  test(
    "streams the completion in OpenAI's chunk layout",
    async () => {
      const baseUrl = proxyBaseUrl();
      const response = await fetch(
        `${baseUrl}/v1/chat/completions`,
        completionBody({ stream: true, stream_options: { include_usage: true } }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const events = parseSseEvents(await response.text());
      expect(events.at(-1)).toBe("[DONE]");
      const chunks = events.filter(
        (event): event is ChatCompletionChunk => typeof event !== "string",
      );
      expect(chunks.length).toBeGreaterThanOrEqual(3);

      const first = chunks[0]!;
      expect(first.object).toBe("chat.completion.chunk");
      expect(first.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
      expect(first.choices[0]?.finish_reason).toBeNull();

      const content = chunks
        .flatMap((chunk) => chunk.choices.flatMap((choice) => choice.delta.content ?? ""))
        .join("");
      expect(content.length).toBeGreaterThan(0);

      const finish = chunks.find(
        (chunk) => chunk.choices[0] !== undefined && chunk.choices[0]?.finish_reason !== null,
      );
      expect(finish?.choices[0]?.delta).toEqual({});
      expect(
        finish?.choices[0]?.finish_reason === "stop" ||
          finish?.choices[0]?.finish_reason === "length",
      ).toBe(true);

      const usageChunk = chunks.at(-1);
      expect(usageChunk?.choices).toEqual([]);
      expect(usageChunk?.usage?.total_tokens).toBeGreaterThan(0);
    },
    { timeout: 60_000 },
  );

  test("returns 502 when the opencode server is unreachable", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("gone") });
    const deadUrl = `http://127.0.0.1:${dead.port}`;
    dead.stop();
    const baseUrl = startServer({
      chatCompletions: new OpencodeChatCompletionsService(createOpencodeHttpClient(deadUrl)),
      models: stubModels,
      embeddings: stubEmbeddings,
    }).baseUrl;

    const response = await fetch(`${baseUrl}/v1/chat/completions`, completionBody());

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});
