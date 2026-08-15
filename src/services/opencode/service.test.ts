import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import {
  assistantInfo,
  completionRequest,
  fakeClient,
  StreamMode,
} from "@/test-support/opencode.ts";
import { OpencodeChatCompletionsService } from "./service.ts";

describe("OpencodeChatCompletionsService (non-stream)", () => {
  test("creates a completion through the opencode client in an isolated tmp directory", async () => {
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

    const result = await service.create(completionRequest(StreamMode.NonStreaming));

    if (result.stream === true) throw new Error("expected a non-streaming result");
    expect(result.value.choices[0]?.message.content).toBe("hi there");
    expect(result.value.choices[0]?.finish_reason).toBe("stop");
    expect(client.createCalls).toHaveLength(1);
    const directory = client.createCalls[0]?.query?.directory;
    expect(directory).toBeDefined();
    expect(typeof directory).toBe("string");
    expect(access(directory!)).rejects.toThrow();
  });

  test("cleans up the tmp directory even when prompting fails", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: { error: new TypeError("prompt failed") },
    });
    const service = new OpencodeChatCompletionsService(client);

    expect(service.create(completionRequest(StreamMode.NonStreaming))).rejects.toThrow();

    expect(client.createCalls).toHaveLength(1);
    const directory = client.createCalls[0]?.query?.directory;
    expect(directory).toBeDefined();
    expect(access(directory!)).rejects.toThrow();
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

  test("flattens replayed history into the prompt", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: {
        data: {
          info: assistantInfo({ finish: "end_turn" }),
          parts: [{ type: "text", id: "p1", sessionID: "s", messageID: "m", text: "hello" }],
        },
      },
    });
    const service = new OpencodeChatCompletionsService(client);

    const result = await service.create({
      model: "anthropic/claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
      stream: false,
    });

    expect(client.calls[0]?.body).toEqual({
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
      parts: [
        { type: "text", text: "user: hi\n\nassistant: hello" },
        { type: "text", text: "again" },
      ],
    });
    expect(client.deleted).toBe(true);
    expect(result.stream).toBe(false);
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

    expect(service.create(completionRequest(StreamMode.NonStreaming))).rejects.toMatchObject({
      status: 502,
    });
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

    expect(service.create(completionRequest(StreamMode.NonStreaming))).rejects.toMatchObject({
      status: 502,
      message: "the opencode session failed",
    });
  });

  test("maps session creation failures to 502", async () => {
    const client = fakeClient({ create: { error: new TypeError("fetch failed") } });
    const service = new OpencodeChatCompletionsService(client);

    expect(service.create(completionRequest(StreamMode.NonStreaming))).rejects.toMatchObject({
      status: 502,
    });

    const directory = client.createCalls[0]?.query?.directory;
    expect(access(directory!)).rejects.toThrow();
  });

  test("maps session creation HTTP errors to their status", async () => {
    const client = fakeClient({
      create: {
        error: new Error("opencode down", {
          cause: {
            body: { name: "InternalServerError", data: { message: "opencode down" } },
            status: 500,
          },
        }),
      },
    });
    const service = new OpencodeChatCompletionsService(client);

    expect(service.create(completionRequest(StreamMode.NonStreaming))).rejects.toMatchObject({
      status: 500,
      message: "opencode down",
    });

    const directory = client.createCalls[0]?.query?.directory;
    expect(access(directory!)).rejects.toThrow();
  });

  test("requires a prompt override before prompting the session", async () => {
    const client = fakeClient({ create: { data: { id: "session-1" } } });
    const service = new OpencodeChatCompletionsService(client);

    expect(service.create(completionRequest(StreamMode.NonStreaming))).rejects.toThrow(
      "fakeClient: overrides.prompt is required",
    );
  });

  test("maps prompt failures to 502", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: { error: new TypeError("fetch failed") },
    });
    const service = new OpencodeChatCompletionsService(client);

    expect(service.create(completionRequest(StreamMode.NonStreaming))).rejects.toMatchObject({
      status: 502,
    });
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

    const result = await service.create(completionRequest(StreamMode.NonStreaming));
    if (result.stream === true) throw new Error("expected a non-streaming result");
    expect(result.value.choices[0]?.message.content).toBe("");
  });
});

describe("OpencodeChatCompletionsService (stream)", () => {
  test("emits a content chunk followed by an empty terminal finish chunk", async () => {
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

    const result = await service.create(completionRequest(StreamMode.Streaming));
    if (result.stream === false) throw new Error("expected a streaming result");

    expect(client.deleted).toBe(true);
    const chunks = [];
    for await (const chunk of result.value) chunks.push(chunk);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.object).toBe("chat.completion.chunk");
    expect(chunks[0]?.model).toBe("anthropic/claude-3-5-sonnet-20241022");
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[0]?.choices[0]?.finish_reason).toBeNull();
    expect(chunks[0]?.usage).toBeUndefined();
    expect(chunks[1]?.choices[0]?.delta).toEqual({ content: "hi there" });
    expect(chunks[1]?.choices[0]?.finish_reason).toBeNull();
    expect(chunks[1]?.usage).toBeUndefined();
    expect(chunks[2]?.choices[0]?.delta).toEqual({});
    expect(chunks[2]?.choices[0]?.finish_reason).toBe("stop");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.method).toBe("prompt");
    expect(client.calls[0]?.body).toEqual({
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
      parts: [{ type: "text", text: "hi" }],
    });
    expect(client.deleted).toBe(true);
  });

  test("emits emulated tool calls as fragments and usage on a dedicated chunk", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: {
        data: {
          info: assistantInfo({ finish: "end_turn" }),
          parts: [
            {
              type: "text",
              id: "p1",
              sessionID: "s",
              messageID: "m",
              text: '<tool_call>{"name":"get_weather","arguments":{"city":"San Francisco","units":"celsius","humidity":85.4}}</tool_call>',
            },
          ],
        },
      },
    });
    const service = new OpencodeChatCompletionsService(client);

    const result = await service.create({
      ...completionRequest(StreamMode.Streaming),
      stream_options: { include_usage: true },
    });
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks = [];
    for await (const chunk of result.value) chunks.push(chunk);

    const rawArguments = '{"city":"San Francisco","units":"celsius","humidity":85.4}';
    expect(chunks).toHaveLength(6);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    const fragments = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    expect(fragments).toHaveLength(3);
    const [first, ...rest] = fragments;
    expect(first).toMatchObject({
      index: 0,
      id: expect.stringMatching(/^call_/),
      type: "function",
      function: { name: "get_weather" },
    });
    for (const fragment of rest) {
      expect(fragment.id).toBeUndefined();
      expect(fragment.type).toBeUndefined();
      expect(fragment.function?.name).toBeUndefined();
      expect(fragment.index).toBe(0);
    }
    expect(fragments.map((fragment) => fragment.function?.arguments ?? "").join("")).toBe(
      rawArguments,
    );
    const finishChunk = chunks.find(
      (chunk) => chunk.choices[0] !== undefined && chunk.choices[0]?.finish_reason !== null,
    );
    expect(finishChunk?.choices[0]?.delta).toEqual({});
    expect(finishChunk?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(finishChunk?.usage).toBeUndefined();
    const usageChunk = chunks.at(-1);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 14,
      completion_tokens: 7,
      total_tokens: 21,
    });
  });

  test("reconstructs a tool call whose arguments span many argument fragments", async () => {
    const client = fakeClient({
      create: { data: { id: "session-1" } },
      prompt: {
        data: {
          info: assistantInfo({ finish: "end_turn" }),
          parts: [
            {
              type: "text",
              id: "p1",
              sessionID: "s",
              messageID: "m",
              text: '<tool_call>{"name":"analyze_readings","arguments":{"sensor":"temperature-humidity-0092","samples":{"cells":[22.4,22.6,22.8,22.9,23.1,23.44],"unit":"celsius"},"note":"calibrated against the reference station"}}</tool_call>',
            },
          ],
        },
      },
    });
    const service = new OpencodeChatCompletionsService(client);

    const result = await service.create(completionRequest(StreamMode.Streaming));
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks = [];
    for await (const chunk of result.value) chunks.push(chunk);

    const rawArguments =
      '{"sensor":"temperature-humidity-0092","samples":{"cells":[22.4,22.6,22.8,22.9,23.1,23.44],"unit":"celsius"},"note":"calibrated against the reference station"}';
    const fragments = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments[0]).toMatchObject({
      index: 0,
      id: expect.stringMatching(/^call_/),
      type: "function",
      function: { name: "analyze_readings" },
    });
    for (const fragment of fragments.slice(1)) {
      expect(fragment.id).toBeUndefined();
      expect(fragment.type).toBeUndefined();
      expect(fragment.function?.name).toBeUndefined();
      expect(fragment.index).toBe(0);
    }
    expect(fragments.map((fragment) => fragment.function?.arguments ?? "").join("")).toBe(
      rawArguments,
    );
  });

  test("opens the stream with a role-only chunk before the content chunk", async () => {
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

    const result = await service.create(completionRequest(StreamMode.Streaming));
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks = [];
    for await (const chunk of result.value) chunks.push(chunk);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[0]?.choices[0]?.finish_reason).toBeNull();
    expect(chunks[1]?.choices[0]?.delta).toEqual({ content: "hi there" });
    expect(chunks[1]?.choices[0]?.delta.role).toBeUndefined();
    expect(chunks[2]?.choices[0]?.delta).toEqual({});
    expect(chunks[2]?.choices[0]?.finish_reason).toBe("stop");
  });

  test("ends an include_usage stream with a dedicated usage chunk", async () => {
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

    const result = await service.create({
      ...completionRequest(StreamMode.Streaming),
      stream_options: { include_usage: true },
    });
    if (result.stream === false) throw new Error("expected a streaming result");
    const chunks = [];
    for await (const chunk of result.value) chunks.push(chunk);

    const usageChunk = chunks.at(-1);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 14,
      completion_tokens: 7,
      total_tokens: 21,
    });
    const finishChunk = chunks.find(
      (chunk) => chunk.choices[0] !== undefined && chunk.choices[0]?.finish_reason !== null,
    );
    expect(finishChunk?.usage).toBeUndefined();
  });
});
