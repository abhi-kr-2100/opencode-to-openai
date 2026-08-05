import { describe, expect, test } from "bun:test";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk";
import { BadRequestError } from "../../http/errors.ts";
import type { ChatCompletionMessage } from "../../openai/chat-completions.ts";
import { toParts, toPrompt } from "./prompt.ts";
import { renderToolSection } from "./tools.ts";

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

  test("rejects malformed content parts", () => {
    const content = [
      "bogus",
      null,
      { type: "unknown", text: "wat" },
      { type: "text", text: 123 },
      { type: "image_url", image_url: "not-an-object" },
      { type: "image_url", image_url: { url: 123 } },
    ];
    for (const part of content) {
      const messages = [{ role: "user", content: [part] }];
      expect(() => toParts(messages as unknown as ChatCompletionMessage[])).toThrow(
        BadRequestError,
      );
    }
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

  test("flattens assistant turns into the transcript", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ];
    expect(toPrompt(messages as ChatCompletionMessage[])).toEqual({
      parts: [
        { type: "text", text: "user: hi\n\nassistant: hello" },
        { type: "text", text: "again" },
      ],
    });
  });

  test("flattens tool calls and results into the transcript", () => {
    const messages = [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: "tool", content: '{"temp":"72F"}', tool_call_id: "t1" },
      { role: "user", content: "thanks" },
    ];
    expect(toPrompt(messages as ChatCompletionMessage[])).toEqual({
      parts: [
        {
          type: "text",
          text:
            'user: weather?\n\n<tool_call>\n{"name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}","id":"t1"}\n</tool_call>\n\n' +
            'tool (t1): {"temp":"72F"}',
        },
        { type: "text", text: "thanks" },
      ],
    });
  });

  test("allows multiple user messages as transcript turns", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    expect(toPrompt(messages as ChatCompletionMessage[])).toEqual({
      parts: [
        { type: "text", text: "user: first" },
        { type: "text", text: "second" },
      ],
    });
  });

  test("drops unknown roles from the transcript", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "function", content: "weird" },
      { role: "user", content: "second" },
    ];
    expect(toPrompt(messages as unknown as ChatCompletionMessage[])).toEqual({
      parts: [
        { type: "text", text: "user: first" },
        { type: "text", text: "second" },
      ],
    });
  });

  test("omits the transcript for a single user message", () => {
    expect(toPrompt([{ role: "user", content: "hi" }])).toEqual({
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("allows a follow-up turn ending on a tool result", () => {
    const messages = [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: "tool", content: '{"temp":"72F"}', tool_call_id: "t1" },
    ];
    expect(toPrompt(messages as ChatCompletionMessage[])).toEqual({
      parts: [
        {
          type: "text",
          text: 'user: weather?\n\n<tool_call>\n{"name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}","id":"t1"}\n</tool_call>',
        },
        { type: "text", text: '{"temp":"72F"}' },
      ],
    });
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

  test("rejects a last message without content", () => {
    expect(() => toPrompt([{ role: "user", content: "" }])).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("must carry some content"),
      }),
    );
  });

  test("appends tool instructions to the system prompt", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const prompt = toPrompt([{ role: "user", content: "hi" }], { tools });
    const system = prompt.system ?? "";
    expect(system).toContain("name: get_weather");
    expect(system).toContain("description: Get the current weather for a city.");
    expect(system).toContain('"city"');
    expect(system).toContain("<tool_call>");
  });

  test("appends tool instructions after leading system messages", () => {
    const tools = [{ type: "function", function: { name: "ping" } }];
    const prompt = toPrompt(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      { tools },
    );
    expect(prompt.system).toBe(`be terse\n\n${renderToolSection(tools, undefined)}`);
  });

  test("forbids tools when tool_choice is none", () => {
    const tools = [{ type: "function", function: { name: "ping" } }];
    const prompt = toPrompt([{ role: "user", content: "hi" }], { tools, toolChoice: "none" });
    expect(prompt.system).toContain("Do not use any custom userspace tools in this conversation.");
  });

  test("requires a tool when tool_choice is required", () => {
    const tools = [{ type: "function", function: { name: "ping" } }];
    const prompt = toPrompt([{ role: "user", content: "hi" }], {
      tools,
      toolChoice: "required",
    });
    expect(prompt.system).toContain(
      "You must use at least one custom userspace tool in this conversation.",
    );
  });

  test("requires a named tool when tool_choice names one", () => {
    const tools = [
      { type: "function", function: { name: "ping" } },
      { type: "function", function: { name: "pong" } },
    ];
    const prompt = toPrompt([{ role: "user", content: "hi" }], {
      tools,
      toolChoice: { type: "function", function: { name: "pong" } },
    });
    expect(prompt.system).toContain(
      'You must use the "pong" custom userspace tool in this conversation.',
    );
  });

  test("rejects tool_choice naming an unknown tool", () => {
    const tools = [{ type: "function", function: { name: "ping" } }];
    expect(() =>
      toPrompt([{ role: "user", content: "hi" }], {
        tools,
        toolChoice: { type: "function", function: { name: "nope" } },
      }),
    ).toThrow(
      expect.objectContaining({ status: 400, message: expect.stringContaining("unknown tool") }),
    );
  });

  test("rejects malformed tool definitions", () => {
    for (const tools of [
      [42],
      [{ type: "other" }],
      [{ type: "function", function: {} }],
      [{ type: "function", function: { name: "" } }],
    ]) {
      expect(() => toPrompt([{ role: "user", content: "hi" }], { tools })).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    }
  });

  test("ignores tools that are empty or not arrays", () => {
    expect(toPrompt([{ role: "user", content: "hi" }], { tools: [] }).system).toBeUndefined();
    expect(toPrompt([{ role: "user", content: "hi" }], { tools: "bogus" }).system).toBeUndefined();
  });

  test("rejects tool_choice without tools", () => {
    expect(() => toPrompt([{ role: "user", content: "hi" }], { toolChoice: "none" })).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("tool_choice requires at least one tool"),
      }),
    );
    expect(
      toPrompt([{ role: "user", content: "hi" }], { toolChoice: "auto" }).system,
    ).toBeUndefined();
  });
});
