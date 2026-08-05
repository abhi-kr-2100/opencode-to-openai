import { BadRequestError } from "../../http/errors.ts";
import { isRecord } from "./guards.ts";

/** The opening tag of the emulated tool call format. */
const TOOL_CALL_START = "<tool_call>";

/** The closing tag of the emulated tool call format. */
const TOOL_CALL_END = "</tool_call>";

/** Matches a complete emulated tool call block: `<tool_call>…</tool_call>`. */
const TOOL_CALL_RE = /<tool_call>/;

/** Matches one or more emulated tool call blocks across a whole text. */
const TOOL_CALLS_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

interface ToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * A tool call parsed out of the model's plain text output, with the raw
 * arguments string (not yet integrated with a caller-supplied id).
 */
export interface ParsedToolCall {
  name: string;
  arguments: string;
}

/**
 * Renders the OpenAI `tools`/`tool_choice` pair into a system-prompt section.
 *
 * opencode has no native support for caller-defined tools, so each tool is
 * described in prose and the model is instructed to emit a machine-parseable
 * `<tool_call>…</tool_call>` block instead of real tool invocations.
 * Returns undefined when no tools were supplied, so prompt construction stays
 * untouched for tool-less requests.
 */
export function renderToolSection(tools: unknown, toolChoice: unknown): string | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    if (toolChoice !== undefined && toolChoice !== "auto") {
      throw new BadRequestError("tool_choice requires at least one tool");
    }
    return undefined;
  }
  const specs = tools.map(toolSpec);
  const lines = [
    "You can access custom userspace tools. External data is ONLY returned by those tools; you have no",
    "other way to read it and must never invent it. To call one, output EXACTLY a single line and nothing",
    "else for that call:",
    "",
    '<tool_call>{"name": "TOOL_NAME", "arguments": {"<arg>": "value", ...}}</tool_call>',
    "",
    "- Replace TOOL_NAME with the exact tool name below.",
    '- Set the "arguments" value to a JSON object matching that tool\'s arguments.',
    "Make one call per needed tool, then stop and wait for the tool result before continuing.",
    "",
    "Custom userspace tools:",
    ...specs.map(renderToolSpec),
  ];
  const choice = toolChoiceSpec(
    toolChoice,
    specs.map((spec) => spec.name),
  );
  if (choice === "none") {
    lines.push("", "Do not use any custom userspace tools in this conversation.");
  } else if (choice === "required") {
    lines.push("", "You must use at least one custom userspace tool in this conversation.");
  } else if (choice !== "auto") {
    lines.push(
      "",
      `You must use the ${JSON.stringify(choice)} custom userspace tool in this conversation.`,
    );
  }
  return lines.join("\n");
}

/** Extracts and validates a single OpenAI tool definition. */
function toolSpec(tool: unknown): ToolSpec {
  if (!isRecord(tool)) throw new BadRequestError("tool definitions must be objects");
  if (tool.type !== "function") {
    throw new BadRequestError(`unsupported tool type ${JSON.stringify(tool.type)}`);
  }
  const fn = isRecord(tool.function) ? tool.function : {};
  if (typeof fn.name !== "string" || fn.name.length === 0) {
    throw new BadRequestError(
      'tool definitions must have a function with a non-empty string "name"',
    );
  }
  return {
    name: fn.name,
    description: typeof fn.description === "string" ? fn.description : undefined,
    parameters: fn.parameters,
  };
}

/**
 * Resolves `tool_choice` to a directive. Returns the name of a tool the model
 * must call, or a keyword; named choices are validated against the tool list.
 */
function toolChoiceSpec(
  toolChoice: unknown,
  names: string[],
): "auto" | "none" | "required" | string {
  if (toolChoice === undefined || toolChoice === "auto") return "auto";
  if (toolChoice === "none" || toolChoice === "required") return toolChoice;
  if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string"
  ) {
    const name = toolChoice.function.name;
    if (!names.includes(name)) {
      throw new BadRequestError(`tool_choice names an unknown tool ${JSON.stringify(name)}`);
    }
    return name;
  }
  throw new BadRequestError(`invalid tool_choice ${JSON.stringify(toolChoice)}`);
}

/** Renders one tool definition as a short prose bullet. */
function renderToolSpec(spec: ToolSpec): string {
  const lines = [`- name: ${spec.name}`];
  if (spec.description !== undefined) lines.push(`  description: ${spec.description}`);
  if (spec.parameters !== undefined) {
    lines.push(`  arguments (JSON object): ${JSON.stringify(spec.parameters)}`);
  }
  return lines.join("\n");
}

/**
 * Splits a model reply into visible text and emulated tool calls.
 *
 * Text outside `<tool_call>…</tool_call>` blocks is preserved as content, and
 * each block's JSON payload is parsed into a tool call. Malformed blocks stay
 * in the content rather than being dropped.
 */
export function splitToolCalls(text: string): { content: string; calls: ParsedToolCall[] } {
  const calls: ParsedToolCall[] = [];
  const content: string[] = [];
  let last = 0;
  for (const match of text.matchAll(TOOL_CALLS_RE)) {
    const index = match.index ?? 0;
    const call = parseToolCallPayload(match[1] ?? "");
    if (call === null) {
      content.push(text.slice(last, index), match[0]);
    } else {
      content.push(text.slice(last, index));
      calls.push(call);
    }
    last = index + match[0].length;
  }
  content.push(text.slice(last));
  return { content: content.join(""), calls };
}

/**
 * Parses the JSON payload of an emulated `<tool_call>` block.
 *
 * The payload is `{"name": "…", "arguments": …}` where `arguments` may be a
 * JSON object or an already-serialized JSON string. Returns null when the
 * block does not contain a usable call.
 */
export function parseToolCallPayload(raw: string): ParsedToolCall | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const name = typeof payload.name === "string" ? payload.name : "";
  if (name.length === 0) return null;
  return { name, arguments: argumentsJson(payload.arguments ?? payload.args) ?? "{}" };
}

/** Coerces a call's arguments into a JSON string, accepting objects and strings. */
function argumentsJson(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** A unique id for a tool call, matching the `call_…` shape clients expect. */
export function newToolCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Incrementally splits streamed text into content and completed tool call
 * blocks. Content is only emitted for text outside blocks, so the call markup
 * never leaks into the visible output, and a call is reported the moment its
 * closing tag arrives so the client can accumulate it in order.
 */
export class ToolCallSplitter {
  #buffer: string;
  #mode: "text" | "args" = "text";

  constructor() {
    this.#buffer = "";
  }

  push(delta: string): SplitterOutput[] {
    this.#buffer += delta;
    return this.#scan();
  }

  /** Emits anything still buffered as text when the stream ends mid-block. */
  flush(): Array<{ kind: "text"; text: string }> {
    if (this.#buffer.length === 0) return [];
    const text = this.#mode === "args" ? `${TOOL_CALL_START}${this.#buffer}` : this.#buffer;
    this.#buffer = "";
    this.#mode = "text";
    return [{ kind: "text", text }];
  }

  #scan(): SplitterOutput[] {
    const outputs: SplitterOutput[] = [];
    for (;;) {
      if (this.#mode === "text") {
        const match = TOOL_CALL_RE.exec(this.#buffer);
        if (match !== null) {
          const index = match.index ?? 0;
          if (index > 0) {
            outputs.push({ kind: "text", text: this.#buffer.slice(0, index) });
          }
          this.#buffer = this.#buffer.slice(index + match[0].length);
          this.#mode = "args";
          continue;
        }
        const holdFrom = textHoldFrom(this.#buffer);
        if (holdFrom === -1) {
          if (this.#buffer.length > 0) outputs.push({ kind: "text", text: this.#buffer });
          this.#buffer = "";
          return outputs;
        }
        const held = this.#buffer.slice(holdFrom);
        const divergentAt = tagDivergenceAt(held);
        if (divergentAt !== -1) {
          outputs.push({ kind: "text", text: this.#buffer.slice(0, holdFrom + divergentAt) });
          this.#buffer = this.#buffer.slice(holdFrom + divergentAt);
          continue;
        }
        if (holdFrom > 0) {
          outputs.push({ kind: "text", text: this.#buffer.slice(0, holdFrom) });
          this.#buffer = held;
          return outputs;
        }
        return outputs;
      }
      const close = this.#buffer.indexOf(TOOL_CALL_END);
      if (close === -1) return outputs;
      const payload = this.#buffer.slice(0, close);
      this.#buffer = this.#buffer.slice(close + TOOL_CALL_END.length);
      this.#mode = "text";
      outputs.push({ kind: "tool_call", payload });
    }
  }
}

export type SplitterOutput =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; payload: string };

/**
 * Returns the index from which an open tool tag might start in the buffered
 * text, or -1 when no partial or complete tag is present. Any trailing text
 * that could become part of the `<tool_call>` tag is held back so tags split
 * across chunks are reassembled.
 */
function textHoldFrom(text: string): number {
  let from = text.lastIndexOf("<tool_call");
  const suffix = templateSuffixLength(text);
  if (suffix > 0) {
    const candidate = text.length - suffix;
    if (from === -1 || candidate < from) from = candidate;
  }
  return from;
}

/** Length of the longest suffix that is a prefix of the opening tag template. */
function templateSuffixLength(text: string): number {
  const max = Math.min(text.length, TOOL_CALL_START.length);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(TOOL_CALL_START.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Finds where a held-back candidate diverges from the opening tag template,
 * proving it was literal text rather than a tool call.
 */
function tagDivergenceAt(held: string): number {
  const max = Math.min(held.length, TOOL_CALL_START.length);
  for (let i = 1; i < max; i += 1) {
    if (held[i] !== TOOL_CALL_START[i]) return i;
  }
  return -1;
}
