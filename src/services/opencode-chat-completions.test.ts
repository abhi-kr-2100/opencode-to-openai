import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  Event,
  FilePartInput,
  Message,
  Part,
  TextPartInput,
} from "@opencode-ai/sdk";
import {
  BadGatewayError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../http/errors.ts";
import type { ChatCompletionMessage, ChatCompletionRequest } from "../openai/chat-completions.ts";
import type { OpencodeClient } from "../opencode/client.ts";
import {
  buildCompletion,
  mapFinishReason,
  mapOpencodeError,
  OpencodeChatCompletionsService,
  parseModel,
  toParts,
  toPrompt,
  toUsage,
} from "./opencode-chat-completions.ts";

interface ErrorResult {
  error: unknown;
}

function isErrorResult(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && "error" in value;
}

async function resolve(value: unknown): Promise<unknown> {
  if (isErrorResult(value)) throw value.error;
  return value;
}

function fakeClient(overrides: {
  create?: unknown;
  prompt?: unknown;
  promptAsync?: unknown;
  subscribe?: AsyncGenerator<Event> | { error: unknown };
  delete?: unknown;
}): OpencodeClient & {
  calls: { method: "prompt" | "promptAsync"; body: unknown }[];
  deleted: boolean;
} {
  const calls: { method: "prompt" | "promptAsync"; body: unknown }[] = [];
  let deleted = false;
  return {
    calls,
    get deleted() {
      return deleted;
    },
    session: {
      create: () => resolve(overrides.create ?? { data: { id: "session-1" } }),
      prompt: (options: unknown) => {
        calls.push({ method: "prompt", body: (options as { body: unknown }).body });
        return resolve(overrides.prompt);
      },
      promptAsync: (options: unknown) => {
        calls.push({ method: "promptAsync", body: (options as { body: unknown }).body });
        return resolve(overrides.promptAsync ?? { data: undefined });
      },
      delete: () => {
        deleted = true;
        return resolve(overrides.delete ?? { data: true });
      },
    },
    event: {
      subscribe: async () => ({
        stream: (await resolve(overrides.subscribe ?? {})) as AsyncGenerator<Event>,
      }),
    },
  } as unknown as OpencodeClient & {
    calls: { method: "prompt" | "promptAsync"; body: unknown }[];
    deleted: boolean;
  };
}

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "message-1",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 0, completed: 1 },
    parentID: "user-1",
    modelID: "claude-3-5-sonnet-20241022",
    providerID: "anthropic",
    mode: "primary",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    ...overrides,
  };
}

function textPart(text: string, id = "part-1", sessionID = "session-1"): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: { id, sessionID, messageID: "message-1", type: "text", text },
      delta: text,
    },
  };
}

function partEvent(part: Part, delta?: string): Event {
  return { type: "message.part.updated", properties: { part, delta } };
}

function updated(info: Message): Event {
  return { type: "message.updated", properties: { info } };
}

function userInfo(): Message {
  return {
    id: "user-1",
    sessionID: "session-1",
    role: "user",
    time: { created: 0 },
    agent: "test",
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
  };
}

function idle(): Event {
  return { type: "session.idle", properties: { sessionID: "session-1" } };
}

function completionRequest(stream: boolean): ChatCompletionRequest {
  return {
    model: "anthropic/claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: "hi" }],
    stream,
  };
}

describe("parseModel", () => {
  test("parses provider/model", () => {
    expect(parseModel("anthropic/claude-3-5-sonnet-20241022")).toEqual({
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    });
  });

  test("returns undefined for providerless or malformed models", () => {
    expect(parseModel("gpt-4o")).toBeUndefined();
    expect(parseModel("/model")).toBeUndefined();
    expect(parseModel("provider/")).toBeUndefined();
  });
});

describe("toParts", () => {
  test("maps string content to a text part", () => {
    expect(toParts([{ role: "user", content: "hi" }])).toEqual([{ type: "text", text: "hi" }]);
  });

  test("skips empty or missing string content", () => {
    expect(
      toParts([
        { role: "user", content: "" },
        { role: "user", content: null },
      ]),
    ).toEqual([]);
  });

  test("maps content part arrays", () => {
    const messages: ChatCompletionMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    const expected: Array<TextPartInput | FilePartInput> = [
      { type: "text", text: "hello" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
    ];
    expect(toParts(messages)).toEqual(expected);
  });

  test("falls back to octet-stream for non-data image urls", () => {
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
    ];
    expect(toParts(messages as ChatCompletionMessage[])).toEqual([
      { type: "file", mime: "application/octet-stream", url: "https://x/y.png" },
    ]);
  });

  test("skips malformed content parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          "bogus",
          null,
          { type: "unknown", text: "wat" },
          { type: "image_url", image_url: "not-an-object" },
          { type: "image_url", image_url: { url: 123 } },
          { type: "text", text: "kept" },
        ],
      },
    ];
    expect(toParts(messages as unknown as ChatCompletionMessage[])).toEqual([
      { type: "text", text: "kept" },
    ]);
  });
});

describe("toPrompt", () => {
  test("maps a single user message to parts without a system prompt", () => {
    expect(toPrompt([{ role: "user", content: "hi" }])).toEqual({
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("carries a leading system message in the system field", () => {
    expect(
      toPrompt([
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ]),
    ).toEqual({
      system: "be terse",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("treats a developer message like a system message", () => {
    expect(
      toPrompt([
        { role: "developer", content: "be terse" },
        { role: "user", content: "hi" },
      ]),
    ).toEqual({
      system: "be terse",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("joins multiple leading system messages", () => {
    expect(
      toPrompt([
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "hi" },
      ]),
    ).toEqual({
      system: "one\n\ntwo",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("extracts text from array content in system messages", () => {
    expect(
      toPrompt([
        { role: "system", content: [{ type: "text", text: "be terse" }] },
        { role: "user", content: "hi" },
      ]),
    ).toEqual({
      system: "be terse",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("skips empty system content", () => {
    expect(
      toPrompt([
        { role: "system", content: "" },
        { role: "user", content: "hi" },
      ]),
    ).toEqual({
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("rejects assistant messages instead of flattening them", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ];
    expect(() => toPrompt(messages as ChatCompletionMessage[])).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("assistant"),
      }),
    );
  });

  test("rejects tool messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1" }] },
      { role: "tool", content: "42", tool_call_id: "t1" },
    ];
    expect(() => toPrompt(messages as ChatCompletionMessage[])).toThrow(
      expect.objectContaining({ status: 400, message: expect.stringContaining("tool") }),
    );
  });

  test("rejects multiple user messages", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    expect(() => toPrompt(messages as ChatCompletionMessage[])).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("multi-turn"),
      }),
    );
  });

  test("rejects a system message after the user message", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "system", content: "late" },
    ];
    expect(() => toPrompt(messages as ChatCompletionMessage[])).toThrow(
      expect.objectContaining({ status: 400, message: expect.stringContaining("come first") }),
    );
  });

  test("rejects requests without a user message", () => {
    const messages = [{ role: "system", content: "only system" }];
    expect(() => toPrompt(messages as ChatCompletionMessage[])).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("user message is required"),
      }),
    );
  });
});

describe("toUsage", () => {
  test("maps opencode token counts", () => {
    expect(toUsage(assistantInfo())).toEqual({
      prompt_tokens: 14,
      completion_tokens: 7,
      total_tokens: 21,
    });
  });
});

describe("mapFinishReason", () => {
  test("maps opencode finish reasons", () => {
    expect(mapFinishReason("max_tokens")).toBe("length");
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("end_turn")).toBe("stop");
    expect(mapFinishReason(undefined)).toBe("stop");
  });
});

describe("buildCompletion", () => {
  test("builds a chat completion from opencode parts", () => {
    const request = { model: "anthropic/claude-3-5-sonnet-20241022", stream: false, messages: [] };
    const parts: Part[] = [
      { type: "text", id: "p1", sessionID: "s", messageID: "m", text: "Hello " },
      { type: "text", id: "p2", sessionID: "s", messageID: "m", text: "world" },
      {
        type: "reasoning",
        id: "p3",
        sessionID: "s",
        messageID: "m",
        text: "thinking...",
        time: { start: 0 },
      },
    ];
    const completion = buildCompletion(request, assistantInfo(), parts);
    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe(request.model);
    expect(completion.id.startsWith("chatcmpl-")).toBe(true);
    expect(completion.choices[0]?.message.content).toBe("Hello world");
    expect(completion.choices[0]?.finish_reason).toBe("stop");
    expect(completion.choices[0]?.logprobs).toBeNull();
    expect(completion.usage).toEqual({ prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 });
  });
});

describe("mapOpencodeError", () => {
  test("maps opencode server errors", () => {
    const error = mapOpencodeError({ name: "BadRequest", data: { message: "bad messages" } });
    expect(error.status).toBe(400);
    expect(error.message).toBe("bad messages");
  });

  test("maps not found and auth errors", () => {
    const notFound = mapOpencodeError({ name: "NotFoundError", data: {} });
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(notFound.status).toBe(404);
    const unauthorized = mapOpencodeError({ name: "UnauthorizedError", data: {} });
    expect(unauthorized).toBeInstanceOf(UnauthorizedError);
    expect(unauthorized.status).toBe(401);
    const auth = mapOpencodeError({ name: "AuthError", data: {} });
    expect(auth.status).toBe(401);
  });

  test("maps unknown named errors to 500 with their message", () => {
    const error = mapOpencodeError({ name: "UnknownError", data: { message: "boom" } });
    expect(error.status).toBe(500);
    expect(error.message).toBe("boom");
  });

  test("maps connection failures to 502", () => {
    const error = mapOpencodeError(new TypeError("fetch failed"));
    expect(error.status).toBe(502);
    expect(error.code).toBe("bad_gateway");
  });

  test("maps transport failures to 502", () => {
    const error = mapOpencodeError(new Error("Unable to connect."));
    expect(error.status).toBe(502);
    expect(error.code).toBe("bad_gateway");
  });

  test("unwraps the SDK error envelope before mapping", () => {
    const error = mapOpencodeError(
      new Error("bad messages", {
        cause: { body: { name: "BadRequest", data: { message: "bad messages" } } },
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toBe("bad messages");
  });

  test("passes through ApiErrors", () => {
    const error = mapOpencodeError(new BadGatewayError("upstream down"));
    expect(error.status).toBe(502);
  });

  test("falls back for anything else", () => {
    expect(mapOpencodeError("oops").status).toBe(500);
    expect(mapOpencodeError(42).status).toBe(500);
    expect(mapOpencodeError({ name: 42 }).status).toBe(500);
  });
});

describe("OpencodeChatCompletionsService (non-stream)", () => {
  test("creates a completion through the opencode client", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: {
        data: {
          info: assistantInfo({ finish: "end_turn" }),
          parts: [{ type: "text", id: "p1", sessionID: "s", messageID: "m", text: "hi there" }],
        },
      },
    });
    const service = new OpencodeChatCompletionsService(client);

    const result = await service.create(completionRequest(false));

    if (result.stream === true) throw new Error("expected a non-streaming result");
    expect(result.value.choices[0]?.message.content).toBe("hi there");
    expect(result.value.choices[0]?.finish_reason).toBe("stop");
  });

  test("forwards the system prompt to the opencode session", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: { data: { info: assistantInfo(), parts: [] } },
    });
    const service = new OpencodeChatCompletionsService(client);

    await service.create({
      model: "anthropic/claude-3-5-sonnet-20241022",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      stream: false,
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.method).toBe("prompt");
    expect(client.calls[0]?.body).toEqual({
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
      system: "be terse",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("forwards the system prompt when streaming", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      subscribe: (async function* () {
        yield textPart("hi");
        yield idle();
      })(),
    });
    const service = new OpencodeChatCompletionsService(client);

    const result = await service.create({
      model: "anthropic/claude-3-5-sonnet-20241022",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks: unknown[] = [];
    for await (const chunk of result.value) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.method).toBe("promptAsync");
    expect(client.calls[0]?.body).toMatchObject({
      system: "be terse",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("rejects unsupported history before creating a session", async () => {
    const client = fakeClient({
      create: { error: new Error("session creation should never be attempted") },
    });
    const service = new OpencodeChatCompletionsService(client);

    await expect(
      service.create({
        model: "anthropic/claude-3-5-sonnet-20241022",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "again" },
        ],
        stream: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("maps a message error to a 502", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: {
        data: {
          info: assistantInfo({
            error: { name: "UnknownError", data: { message: "provider exploded" } },
          }),
          parts: [],
        },
      },
    });
    const service = new OpencodeChatCompletionsService(client);

    await expect(service.create(completionRequest(false))).rejects.toMatchObject({ status: 502 });
  });

  test("falls back to a generic message when the session error has none", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: {
        data: {
          info: assistantInfo({ error: { name: "MessageOutputLengthError", data: {} } }),
          parts: [],
        },
      },
    });
    const service = new OpencodeChatCompletionsService(client);

    await expect(service.create(completionRequest(false))).rejects.toMatchObject({
      status: 502,
      message: "the opencode session failed",
    });
  });

  test("maps session creation failures to 502", async () => {
    const client = fakeClient({ create: { error: new TypeError("fetch failed") } });
    const service = new OpencodeChatCompletionsService(client);

    await expect(service.create(completionRequest(false))).rejects.toMatchObject({ status: 502 });
  });

  test("maps session creation HTTP errors to 500", async () => {
    const client = fakeClient({
      create: { error: { name: "InternalServerError", data: { message: "opencode down" } } },
    });
    const service = new OpencodeChatCompletionsService(client);

    await expect(service.create(completionRequest(false))).rejects.toMatchObject({
      status: 500,
      message: "opencode down",
    });
  });

  test("maps prompt failures to 502", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: { error: new TypeError("fetch failed") },
    });
    const service = new OpencodeChatCompletionsService(client);

    await expect(service.create(completionRequest(false))).rejects.toMatchObject({ status: 502 });
  });

  test("ignores session deletion failures", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: {
        data: { info: assistantInfo(), parts: [] },
      },
      delete: { error: { name: "NotFoundError" } },
    });
    const service = new OpencodeChatCompletionsService(client);

    const result = await service.create(completionRequest(false));
    if (result.stream === true) throw new Error("expected a non-streaming result");
    expect(result.value.choices[0]?.message.content).toBe("");
  });
});

describe("OpencodeChatCompletionsService (stream)", () => {
  async function collect(events: Event[], includeUsage = false) {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      subscribe: (async function* () {
        for (const event of events) yield event;
      })(),
    });
    const service = new OpencodeChatCompletionsService(client);
    const result = await service.create({
      ...completionRequest(true),
      stream_options: { include_usage: includeUsage },
    });
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks = [];
    for await (const chunk of result.value) chunks.push(chunk);
    return chunks;
  }

  test("streams content deltas and a finish chunk", async () => {
    const chunks = await collect([
      textPart("Hel"),
      textPart("lo"),
      updated(assistantInfo({ finish: "end_turn" })),
      idle(),
    ]);

    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    expect(chunks[1]?.choices[0]?.delta.content).toBe("Hel");
    expect(chunks[2]?.choices[0]?.delta.content).toBe("lo");
    expect(chunks[3]?.choices[0]?.finish_reason).toBe("stop");
    expect(chunks[3]?.choices[0]?.delta).toEqual({});
  });

  test("computes deltas from part text when no delta is provided", async () => {
    const part: Part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "text",
      text: "Hello",
    };
    const chunks = await collect([
      partEvent(part),
      partEvent({ ...part, text: "Hello world" }),
      idle(),
    ]);

    expect(chunks[1]?.choices[0]?.delta.content).toBe("Hello");
    expect(chunks[2]?.choices[0]?.delta.content).toBe(" world");
  });

  test("skips events from other sessions and non-text parts", async () => {
    const foreign = textPart("ignored", "part-x", "other-session");
    const reasoning = partEvent({
      id: "part-r",
      sessionID: "session-1",
      messageID: "message-1",
      type: "reasoning",
      text: "thinking...",
      time: { start: 0 },
    });
    const chunks = await collect([foreign, reasoning, textPart("kept"), idle()]);

    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.choices[0]?.delta.content).toBe("kept");
  });

  test("skips non-assistant or incomplete message updates", async () => {
    const chunks = await collect([
      updated(userInfo()),
      updated(assistantInfo({ time: { created: 0 } })),
      textPart("kept"),
      idle(),
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.choices[0]?.delta.content).toBe("kept");
  });

  test("emits a usage chunk when include_usage is set", async () => {
    const chunks = await collect([updated(assistantInfo()), idle()], true);

    const usageChunk = chunks.at(-1);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 14,
      completion_tokens: 7,
      total_tokens: 21,
    });
  });

  test("rejects when the session errors", async () => {
    const chunks = collect([{ type: "session.error", properties: { sessionID: "session-1" } }]);
    await expect(chunks).rejects.toMatchObject({ status: 502 });
  });

  test("rejects when the stream ends before the session completes", async () => {
    const chunks = collect([textPart("Hel")]);
    await expect(chunks).rejects.toMatchObject({
      status: 502,
      message: "opencode event stream ended before the session completed",
    });
  });

  test("surfaces a prompt_async failure after the stream ends", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      promptAsync: new Promise((_, reject) => {
        setTimeout(() => reject(new Error("prompt failed")), 0);
      }),
      subscribe: (async function* () {
        yield textPart("Hel");
        yield idle();
      })(),
    });
    const service = new OpencodeChatCompletionsService(client);
    const result = await service.create(completionRequest(true));
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks = [];
    const consume = (async () => {
      for await (const chunk of result.value) chunks.push(chunk);
    })();
    await expect(consume).rejects.toThrow("prompt failed");
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("ignores session deletion failures during streaming", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      delete: { error: { name: "NotFoundError" } },
      subscribe: (async function* () {
        yield textPart("kept");
        yield idle();
      })(),
    });
    const service = new OpencodeChatCompletionsService(client);
    const result = await service.create(completionRequest(true));
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks = [];
    for await (const chunk of result.value) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
  });

  test("deletes the session when event subscription fails during stream setup", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      subscribe: { error: new Error("subscribe failed") },
    });
    const service = new OpencodeChatCompletionsService(client);

    await expect(service.create(completionRequest(true))).rejects.toMatchObject({ status: 502 });
    expect(client.deleted).toBe(true);
  });
});
