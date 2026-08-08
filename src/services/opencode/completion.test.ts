import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk";
import type { ChatCompletion } from "../../openai/chat-completions.ts";
import { assistantInfo } from "@/test-support/opencode.ts";
import { buildChunks, buildCompletion, mapFinishReason, toUsage } from "./completion.ts";

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

  test("surfaces emulated tool calls with finish_reason tool_calls", () => {
    const request = { model: "anthropic/claude-3-5-sonnet-20241022", stream: false, messages: [] };
    const parts: Part[] = [
      {
        type: "text",
        id: "p1",
        sessionID: "s",
        messageID: "m",
        text: '<tool_call>{"name":"get_weather","arguments":{"city":"SF"}}</tool_call>',
      },
    ];
    const completion = buildCompletion(request, assistantInfo({ finish: "end_turn" }), parts);
    const message = completion.choices[0]!.message;
    expect(message.content).toBeNull();
    expect(message.tool_calls).toHaveLength(1);
    const call = message.tool_calls?.[0];
    expect(call?.type).toBe("function");
    expect(call?.id.startsWith("call_")).toBe(true);
    expect(call?.function).toEqual({ name: "get_weather", arguments: '{"city":"SF"}' });
    expect(completion.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("keeps preamble text next to emulated tool calls", () => {
    const request = { model: "anthropic/claude-3-5-sonnet-20241022", stream: false, messages: [] };
    const parts: Part[] = [
      {
        type: "text",
        id: "p1",
        sessionID: "s",
        messageID: "m",
        text: 'Checking now. <tool_call>{"name":"ping","arguments":{"n":1}}</tool_call>',
      },
    ];
    const completion = buildCompletion(request, assistantInfo(), parts);
    expect(completion.choices[0]?.message.content).toBe("Checking now. ");
    expect(completion.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(completion.choices[0]?.finish_reason).toBe("tool_calls");
  });
});

describe("buildChunks", () => {
  test("frames a completion as role, content, and terminal finish chunks", () => {
    const request = { model: "anthropic/claude-3-5-sonnet-20241022", stream: true, messages: [] };
    const completion: ChatCompletion = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 },
    };

    const chunks = buildChunks(request, completion);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      id: completion.id,
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    });
    expect(chunks[1]).toEqual({
      id: completion.id,
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: { content: "Hello world" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    });
    expect(chunks[2]).toEqual({
      id: completion.id,
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
    });
  });

  test("emits tool calls as fragments with a tool_calls terminal chunk", () => {
    const request = { model: "anthropic/claude-3-5-sonnet-20241022", stream: true, messages: [] };
    const completion: ChatCompletion = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 },
    };

    const chunks = buildChunks(request, completion);

    const fragments = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    expect(fragments).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);
    expect(chunks[1]?.choices[0]?.delta.tool_calls).toEqual(fragments);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    const terminal = chunks.at(-1);
    expect(terminal?.choices[0]?.delta).toEqual({});
    expect(terminal?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("places usage on a dedicated chunk only when include_usage is set", () => {
    const request = {
      model: "anthropic/claude-3-5-sonnet-20241022",
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    };
    const completion: ChatCompletion = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 },
    };

    const chunks = buildChunks(request, completion);

    const usageChunk = chunks.at(-1);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 14,
      completion_tokens: 7,
      total_tokens: 21,
    });
    expect(chunks.filter((chunk) => chunk.usage !== undefined)).toHaveLength(1);
  });

  test("omits usage when include_usage is not requested", () => {
    const request = { model: "anthropic/claude-3-5-sonnet-20241022", stream: true, messages: [] };
    const completion: ChatCompletion = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 },
    };

    const chunks = buildChunks(request, completion);

    expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true);
  });
});

describe("buildChunks (OpenAI wire fidelity)", () => {
  const request = { model: "anthropic/claude-3-5-sonnet-20241022", stream: true, messages: [] };

  function completionWith(message: ChatCompletion["choices"][number]["message"]): ChatCompletion {
    return {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.tool_calls !== undefined ? "tool_calls" : "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 },
    };
  }

  test("starts the stream with a role-only chunk carrying empty content", () => {
    const chunks = buildChunks(
      request,
      completionWith({ role: "assistant", content: "Hello world" }),
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[0]?.choices[0]?.finish_reason).toBeNull();
  });

  test("carries the complete content on a chunk that does not repeat the role", () => {
    const chunks = buildChunks(
      request,
      completionWith({ role: "assistant", content: "Hello world" }),
    );

    const contentChunks = chunks.filter((chunk) => {
      const { role, content } = chunk.choices[0]?.delta ?? {};
      return role === undefined && content !== undefined;
    });
    const content = contentChunks
      .flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? ""))
      .join("");
    expect(content).toBe("Hello world");
    expect(contentChunks).toHaveLength(1);
    expect(contentChunks[0]?.choices[0]?.delta.role).toBeUndefined();
  });

  test("fragments tool call arguments across chunks with metadata only on the first fragment", () => {
    const argumentsText = '{"city":"San Francisco","units":"celsius","humidity":85.4}';
    const chunks = buildChunks(
      request,
      completionWith({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: argumentsText },
          },
        ],
      }),
    );

    const fragments = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    expect(fragments.length).toBeGreaterThan(1);
    const [first, ...rest] = fragments;
    expect(first).toMatchObject({
      index: 0,
      id: "call_1",
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
      argumentsText,
    );
  });

  test("emits a single tool-call frame with the call id and name for empty arguments", () => {
    const chunks = buildChunks(
      request,
      completionWith({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      }),
    );

    const fragments = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toEqual({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
  });

  test("places usage on a dedicated final chunk with empty choices", () => {
    const chunks = buildChunks(
      { ...request, stream_options: { include_usage: true } },
      completionWith({ role: "assistant", content: "hi" }),
    );

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
    expect(finishChunk?.choices[0]?.delta).toEqual({});
  });
});
