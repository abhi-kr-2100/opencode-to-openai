import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk";
import { assistantInfo } from "@/test-support/opencode.ts";
import { buildCompletion, mapFinishReason, toUsage } from "./completion.ts";

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
