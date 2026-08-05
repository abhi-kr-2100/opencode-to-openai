import { describe, expect, test } from "bun:test";
import { renderToolSection, splitToolCalls, ToolCallSplitter } from "./tools.ts";

/** Runs a sequence of deltas through a fresh splitter, tagging each output. */
function split(deltas: string[]): string[] {
  const splitter = new ToolCallSplitter();
  const outputs: string[] = [];
  for (const delta of deltas) {
    for (const output of splitter.push(delta)) {
      outputs.push(output.kind === "text" ? `text:${output.text}` : `call:${output.payload}`);
    }
  }
  return outputs;
}

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
});

describe("ToolCallSplitter", () => {
  test("passes text through", () => {
    expect(split(["Hel", "lo world"])).toEqual(["text:Hel", "text:lo world"]);
  });

  test("parses a block split across arbitrary chunk boundaries", () => {
    expect(
      split([
        "Sure, <tool_call>",
        '{"name":"get_weather","arguments":{"city":"SF"}}',
        "</tool_call>",
        " done",
      ]),
    ).toEqual([
      "text:Sure, ",
      'call:{"name":"get_weather","arguments":{"city":"SF"}}',
      "text: done",
    ]);
  });

  test("parses multiple blocks and interleaved text", () => {
    expect(
      split([
        '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>',
        ' and <tool_call>{"name":"b","arguments":{"y":2}}</tool_call>',
      ]),
    ).toEqual([
      'call:{"name":"a","arguments":{"x":1}}',
      "text: and ",
      'call:{"name":"b","arguments":{"y":2}}',
    ]);
  });

  test("holds a literal tag-looking prefix and flushes it when it diverges", () => {
    const outputs = split(["text <tool_call nope", ", really"]);
    expect(outputs.filter((output) => output.startsWith("call:"))).toEqual([]);
    expect(outputs.map((output) => output.slice("text:".length)).join("")).toBe(
      "text <tool_call nope, really",
    );
  });

  test("holds a partial opening tag until the tag completes", () => {
    expect(
      split(["a <tool", "_call", ">", '{"name":"x","arguments":{"n":1}}', "</tool_call>", " b"]),
    ).toEqual(["text:a ", 'call:{"name":"x","arguments":{"n":1}}', "text: b"]);
  });

  test("flushes an unclosed block as text", () => {
    const splitter = new ToolCallSplitter();
    expect(splitter.push('<tool_call>{"name":"a","arguments":{"x":1}}')).toEqual([]);
    expect(splitter.flush()).toEqual([
      { kind: "text", text: '<tool_call>{"name":"a","arguments":{"x":1}}' },
    ]);
  });

  test("flushes trailing held text", () => {
    const splitter = new ToolCallSplitter();
    expect(splitter.push("hello <tool_c")).toEqual([{ kind: "text", text: "hello " }]);
    expect(splitter.flush()).toEqual([{ kind: "text", text: "<tool_c" }]);
  });
});
