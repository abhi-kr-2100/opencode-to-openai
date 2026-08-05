import { describe, expect, test } from "bun:test";
import type { Event, Part } from "@opencode-ai/sdk";
import {
  assistantInfo,
  completionRequest,
  fakeClient,
  idle,
  partEvent,
  textPart,
  updated,
  userInfo,
} from "@/test-support/opencode.ts";
import { OpencodeChatCompletionsService } from "./service.ts";

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

/** Runs a sequence of events through a fresh service, collecting the chunks. */
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

describe("OpencodeChatCompletionsService (stream)", () => {
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

  test("strips tool call markup and streams tool call deltas", async () => {
    const chunks = await collect([
      textPart("Sure, <tool_c"),
      textPart("all>"),
      textPart('{"name":"get_weather","arguments":{"city": "SF"}}'),
      textPart("</tool_call> done"),
      updated(assistantInfo({ finish: "end_turn" })),
      idle(),
    ]);

    const deltas = chunks.map((chunk) => chunk.choices[0]?.delta);
    expect(deltas).toEqual([
      { role: "assistant", content: "" },
      { content: "Sure, " },
      {
        tool_calls: [
          {
            index: 0,
            id: expect.stringMatching(/^call_/),
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          },
        ],
      },
      { content: " done" },
      {},
    ]);
    const finish = chunks.at(-1)?.choices[0];
    expect(finish?.finish_reason).toBe("tool_calls");
    expect(finish?.delta).toEqual({});
  });

  test("emits a plain stop finish when no tool calls were made", async () => {
    const chunks = await collect([textPart("hi"), updated(assistantInfo()), idle()]);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
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

  test("flushes a held-back partial tag when the message completes", async () => {
    const chunks = await collect([
      textPart("kept <tool_c"),
      updated(assistantInfo({ finish: "end_turn" })),
      idle(),
    ]);

    expect(chunks).toHaveLength(4);
    expect(chunks[1]?.choices[0]?.delta.content).toBe("kept ");
    expect(chunks[2]?.choices[0]?.delta.content).toBe("<tool_c");
    expect(chunks[3]?.choices[0]?.finish_reason).toBe("stop");
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
