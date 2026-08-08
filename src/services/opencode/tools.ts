import { BadRequestError } from "../../http/errors.ts";
import type { ChatCompletionRequest } from "../../openai/chat-completions.ts";
import { isRecord } from "./guards.ts";

/** A caller-supplied tool definition from the request body. */
type RequestTool = NonNullable<ChatCompletionRequest["tools"]>[number];

/** A `tool_choice` value from the request body. */
type RequestToolChoice = ChatCompletionRequest["tool_choice"];

/** The opening tag of the emulated tool call format. */
const TOOL_CALL_START = "<tool_call>";

/** The closing tag of the emulated tool call format. */
const TOOL_CALL_END = "</tool_call>";

interface ToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
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
 * `<tool_call>…</tool_call>` block instead of real tool invocations.
 * Returns undefined when no tools were supplied, so prompt construction stays
 * untouched for tool-less requests. When `tool_choice` is `none`, the section
 * is a single sentence directing the model not to call tools, with no tool
 * listing.
 */
export function renderToolSection(
  tools: ChatCompletionRequest["tools"],
  toolChoice: ChatCompletionRequest["tool_choice"],
): string | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    if (toolChoice !== undefined && toolChoice !== "auto") {
      throw new BadRequestError("tool_choice requires at least one tool");
    }
    return undefined;
  }
  const specs = tools.map(toolSpec);
  switch (toolChoice) {
    case undefined:
    case "auto":
      return renderToolList(specs);
    case "none":
      return "Do not use any tools in this conversation.";
    case "required":
      return renderToolList(
        specs,
        "You must use at least one custom userspace tool in this conversation.",
      );
    default:
      return renderToolList(
        specs,
        `You must use the ${JSON.stringify(requiredToolName(toolChoice, specs))} custom userspace tool in this conversation.`,
      );
  }
}

/** Renders the prose tool listing, appending `directive` when one is given. */
function renderToolList(specs: ToolSpec[], directive?: string): string {
  const lines = [
    "You can access custom userspace tools. To call one, output EXACTLY a single line and nothing else for that call:",
    '<tool_call>{"name": "TOOL_NAME", "arguments": {"<arg>": "value", ...}}</tool_call>',
    "- Replace TOOL_NAME with the exact tool name.",
    '- Set the "arguments" value to a JSON object matching that tool\'s arguments.',
    "Make one call per needed tool, then stop and wait for the tool result before continuing.",
    "",
    "Custom userspace tools:",
    ...specs.map(renderToolSpec),
  ];
  if (directive !== undefined) lines.push("", directive);
  return lines.join("\n");
}

/** Extracts and validates a single OpenAI tool definition. */
function toolSpec(tool: RequestTool): ToolSpec {
  if (!isRecord(tool)) throw new BadRequestError("tool definitions must be objects");
  if (tool.type !== "function") {
    throw new BadRequestError(`unsupported tool type ${JSON.stringify(tool.type)}`);
  }
  const fn: Record<string, unknown> = isRecord(tool.function) ? tool.function : {};
  if (typeof fn.name !== "string" || fn.name.length === 0) {
    throw new BadRequestError(
      'tool definitions must have a function with a non-empty string "name"',
    );
  }
  return {
    name: fn.name,
    description: typeof fn.description === "string" ? fn.description : undefined,
    parameters: isRecord(fn.parameters) ? fn.parameters : undefined,
  };
}

/**
 * Pins the tool a `{"type": "function", "function": {"name": …}}` choice
 * demands, validating the shape and that the name matches a supplied tool.
 */
function requiredToolName(toolChoice: RequestToolChoice, specs: ToolSpec[]): string {
  if (!isRecord(toolChoice) || toolChoice.type !== "function") {
    throw new BadRequestError(`invalid tool_choice ${JSON.stringify(toolChoice)}`);
  }
  if (!isRecord(toolChoice.function) || typeof toolChoice.function.name !== "string") {
    throw new BadRequestError('tool_choice of type "function" must name a function');
  }
  const name = toolChoice.function.name;
  if (!specs.some((spec) => spec.name === name)) {
    throw new BadRequestError(`tool_choice names an unknown tool ${JSON.stringify(name)}`);
  }
  return name;
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
 * Locates the first `TOOL_CALL_END` occurrence that is not inside a JSON
 * string, honoring backslash-escaped characters. Returns -1 when no valid
 * delimiter follows `from`.
 */
function findToolCallEnd(text: string, from: number): number {
  let inString = false;
  for (let i = from; i < text.length; i++) {
    if (inString) {
      if (text[i] === "\\") {
        i++;
      } else if (text[i] === '"') {
        inString = false;
      }
    } else if (text[i] === '"') {
      inString = true;
    } else if (text.startsWith(TOOL_CALL_END, i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Splits a model reply into emitted text and emulated tool calls.
 *
 * Text outside `<tool_call>…</tool_call>` blocks is preserved as content, and
 * each block's JSON payload is parsed into a tool call. Malformed blocks stay
 * in the content rather than being dropped.
 */
export function splitToolCalls(text: string): { content: string; calls: ParsedToolCall[] } {
  const calls: ParsedToolCall[] = [];
  const content: string[] = [];
  let last = 0;
  for (;;) {
    const start = text.indexOf(TOOL_CALL_START, last);
    if (start === -1) {
      content.push(text.slice(last));
      break;
    }
    content.push(text.slice(last, start));
    const argsStart = start + TOOL_CALL_START.length;
    const end = findToolCallEnd(text, argsStart);
    if (end === -1) {
      content.push(text.slice(start));
      break;
    }
    const call = parseToolCallPayload(text.slice(argsStart, end));
    if (call === null) {
      content.push(text.slice(start, end + TOOL_CALL_END.length));
    } else {
      calls.push(call);
    }
    last = end + TOOL_CALL_END.length;
  }
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
  const args = argumentsJson(payload.arguments);
  if (args === null) return null;
  return { name, arguments: args };
}

/** Coerces a call's arguments into a JSON string, accepting objects and strings. */
function argumentsJson(value: unknown): string | null {
  if (value === undefined) return "{}";
  if (typeof value === "string") return value;
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return "{}";
}

/** A unique id for a tool call, matching the `call_…` shape clients expect. */
export function newToolCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}
