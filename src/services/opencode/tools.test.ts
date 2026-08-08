import { describe, expect, test } from "bun:test";
import { renderToolSection, splitToolCalls } from "./tools.ts";

describe("renderToolSection", () => {
  test("renders undefined without tools", () => {
    expect(renderToolSection(undefined, undefined)).toBeUndefined();
    expect(renderToolSection([], "auto")).toBeUndefined();
  });

  test("renders a named tool with description and schema", () => {
    const section = renderToolSection(
      [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Current weather.",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
      undefined,
    );
    expect(section).toContain("- name: get_weather");
    expect(section).toContain("  description: Current weather.");
    expect(section).toContain("  arguments (JSON object):");
    expect(section).toContain('{"type":"object","properties":{"city":{"type":"string"}}}');
  });

  test("renders multiple tools as separate bullets", () => {
    const section = renderToolSection(
      [
        { type: "function", function: { name: "a" } },
        { type: "function", function: { name: "b" } },
      ],
      undefined,
    );
    expect(section).toContain("- name: a");
    expect(section).toContain("- name: b");
  });

  test("returns only a no-tools directive for none", () => {
    const section = renderToolSection(
      [{ type: "function", function: { name: "get_weather" } }],
      "none",
    );
    expect(section).toBe("Do not use any tools in this conversation.");
  });

  test("rejects a function tool_choice without a name", () => {
    expect(() =>
      renderToolSection([{ type: "function", function: { name: "get_weather" } }], {
        type: "function",
      } as unknown as Parameters<typeof renderToolSection>[1]),
    ).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("must name a function"),
      }),
    );
  });

  test("rejects a function tool_choice naming an unknown tool", () => {
    expect(() =>
      renderToolSection([{ type: "function", function: { name: "get_weather" } }], {
        type: "function",
        function: { name: "nope" },
      }),
    ).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("names an unknown tool"),
      }),
    );
  });

  test("rejects a non-function tool_choice", () => {
    expect(() =>
      renderToolSection([{ type: "function", function: { name: "get_weather" } }], "random"),
    ).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining("invalid tool_choice"),
      }),
    );
  });
});

describe("splitToolCalls", () => {
  test("returns plain text unchanged", () => {
    expect(splitToolCalls("hello world")).toEqual({ content: "hello world", calls: [] });
  });

  test("extracts a single tool call and strips it from content", () => {
    expect(
      splitToolCalls(
        'Let me check.\n<tool_call>{"name":"get_weather","arguments":{"city":"SF"}}</tool_call>',
      ),
    ).toEqual({
      content: "Let me check.\n",
      calls: [{ name: "get_weather", arguments: '{"city":"SF"}' }],
    });
  });

  test("extracts multiple tool calls in order", () => {
    const { content, calls } = splitToolCalls(
      '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call> and ' +
        '<tool_call>{"name":"b","arguments":{"y":2}}</tool_call>',
    );
    expect(content).toBe(" and ");
    expect(calls).toEqual([
      { name: "a", arguments: '{"x":1}' },
      { name: "b", arguments: '{"y":2}' },
    ]);
  });

  test("accepts arguments as a JSON string", () => {
    const { content, calls } = splitToolCalls(
      '<tool_call>{"name":"a","arguments":"{\\"x\\":1}"}</tool_call>',
    );
    expect(content).toBe("");
    expect(calls).toEqual([{ name: "a", arguments: '{"x":1}' }]);
  });

  test("ignores a closing delimiter inside a string argument", () => {
    const { content, calls } = splitToolCalls(
      '<tool_call>{"name":"a","arguments":{"note":"see </tool_call> text"}}</tool_call>',
    );
    expect(content).toBe("");
    expect(calls).toEqual([{ name: "a", arguments: '{"note":"see </tool_call> text"}' }]);
  });

  test("honors escaped quotes and backslashes when scanning for the delimiter", () => {
    const { content, calls } = splitToolCalls(
      '<tool_call>{"name":"a","arguments":{"note":"a \\"quote\\" and \\\\ then </tool_call> text"}}</tool_call>',
    );
    expect(content).toBe("");
    expect(calls).toEqual([
      {
        name: "a",
        arguments: '{"note":"a \\"quote\\" and \\\\ then </tool_call> text"}',
      },
    ]);
  });

  test("treats a reply whose only delimiter is inside a string as incomplete", () => {
    expect(splitToolCalls('<tool_call>{"name":"a","arg":"x</tool_call>"}')).toEqual({
      content: '<tool_call>{"name":"a","arg":"x</tool_call>"}',
      calls: [],
    });
  });

  test("coerces non-object arguments to empty JSON", () => {
    expect(splitToolCalls('<tool_call>{"name":"a","arguments":42}</tool_call>')).toEqual({
      content: "",
      calls: [{ name: "a", arguments: "{}" }],
    });
  });

  test("keeps malformed blocks in the content", () => {
    expect(splitToolCalls("hi <tool_call>oops}</tool_call> bye")).toEqual({
      content: "hi <tool_call>oops}</tool_call> bye",
      calls: [],
    });
  });

  test("leaves unclosed blocks in the content", () => {
    expect(splitToolCalls('hi <tool_call>{"name":"a","arguments":{"x":1}}')).toEqual({
      content: 'hi <tool_call>{"name":"a","arguments":{"x":1}}',
      calls: [],
    });
  });

  test("keeps a block in the content when serializing its arguments fails", () => {
    const original = JSON.stringify;
    (JSON as { stringify: typeof original }).stringify = () => {
      throw new Error("circular");
    };
    try {
      expect(
        splitToolCalls('hi <tool_call>{"name":"a","arguments":{"x":1}}</tool_call> bye'),
      ).toEqual({
        content: 'hi <tool_call>{"name":"a","arguments":{"x":1}}</tool_call> bye',
        calls: [],
      });
    } finally {
      (JSON as { stringify: typeof original }).stringify = original;
    }
  });
});
