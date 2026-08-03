import type {
  AssistantMessage,
  Event,
  FilePartInput,
  Part,
  TextPart,
  TextPartInput,
} from "@opencode-ai/sdk";
import {
  ApiError,
  BadGatewayError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "../http/errors.ts";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionFinishReason,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponseMessage,
  ChatCompletionToolCall,
  ChatCompletionUsage,
} from "../openai/chat-completions.ts";
import type { OpencodeClient } from "../opencode/client.ts";
import type { ChatCompletionResult, ChatCompletionsService } from "./chat-completions.ts";

interface OpencodeModel {
  providerID: string;
  modelID: string;
}

/** The opening tag of the emulated tool call format. */
const TOOL_CALL_START = "<tool_call>";

/** The closing tag of the emulated tool call format. */
const TOOL_CALL_END = "</tool_call>";

/** Matches a complete emulated tool call block: `<tool_call>…</tool_call>`. */
const TOOL_CALL_RE = /<tool_call>/;

/** Matches one or more emulated tool call blocks across a whole text. */
const TOOL_CALLS_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/**
 * Splits a model id into the provider/model pair opencode expects.
 *
 * The id must contain exactly one slash with non-empty parts on both sides;
 * anything else is rejected rather than guessed.
 */
export function parseModel(model: string): OpencodeModel {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new BadRequestError(
      `invalid model "${model}": expected a "provider/model" pair, e.g. "anthropic/claude-3-5-sonnet-20241022"`,
    );
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

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
function parseToolCallPayload(raw: string): ParsedToolCall | null {
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
function newToolCallId(): string {
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

type SplitterOutput = { kind: "text"; text: string } | { kind: "tool_call"; payload: string };

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

/**
 * Flattens OpenAI message content into the opencode part input format.
 *
 * String content becomes a single text part; array content is mapped
 * part-by-part, with text parts passing through and image URLs becoming file
 * parts. Malformed or unsupported entries are rejected rather than dropped.
 */
export function toParts(messages: ChatCompletionMessage[]): Array<TextPartInput | FilePartInput> {
  const parts: Array<TextPartInput | FilePartInput> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.length > 0) parts.push({ type: "text", text: message.content });
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const contentPart of message.content) {
        if (!isRecord(contentPart)) {
          throw new BadRequestError("message content parts must be objects");
        }
        switch (contentPart.type) {
          // Text parts pass through as-is.
          case "text":
            if (typeof contentPart.text !== "string") {
              throw new BadRequestError('text content parts must have a string "text" field');
            }
            if (contentPart.text.length > 0) parts.push({ type: "text", text: contentPart.text });
            break;
          // OpenAI image URLs become opencode file parts.
          case "image_url":
            if (!isRecord(contentPart.image_url) || typeof contentPart.image_url.url !== "string") {
              throw new BadRequestError('image_url content parts must have a string "url" field');
            }
            parts.push({
              type: "file",
              mime: mimeFromUrl(contentPart.image_url.url),
              url: contentPart.image_url.url,
            });
            break;
          default:
            throw new BadRequestError(
              `unsupported content part type ${JSON.stringify(contentPart.type)}`,
            );
        }
      }
    }
  }
  return parts;
}

export interface PromptInput {
  system?: string;
  parts: Array<TextPartInput | FilePartInput>;
}

export interface PromptOptions {
  tools?: unknown;
  toolChoice?: unknown;
}

/**
 * Maps OpenAI chat messages onto an opencode session prompt.
 *
 * Leading `system`/`developer` instructions are carried in the prompt's
 * `system` field, followed by the emulated tool instructions when tools were
 * requested. The final message becomes the prompt's parts — whether it is a
 * user turn or a `tool` result continuing an agent loop. Any preceding
 * conversation turns are flattened into a transcript text part with role
 * markers, since opencode starts from a fresh session and cannot replay prior
 * assistant turns or tool results as real session messages.
 */
export function toPrompt(
  messages: ChatCompletionMessage[],
  options: PromptOptions = {},
): PromptInput {
  const system: string[] = [];
  let index = 0;
  while (index < messages.length && isSystemRole(messages[index]?.role)) {
    const text = contentText(messages[index]!);
    if (text !== undefined && text.length > 0) system.push(text);
    index += 1;
  }

  const conversation = messages.slice(index);
  for (const message of conversation) {
    if (isSystemRole(message.role)) {
      throw new BadRequestError(
        `a ${message.role} message cannot follow a user message: system instructions must come first`,
      );
    }
  }

  let lastUserIndex = -1;
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) {
    throw new BadRequestError("a user message is required");
  }

  const lastIndex = conversation.length - 1;
  const transcript = flattenTranscript(conversation, lastIndex);
  const parts: Array<TextPartInput | FilePartInput> = [];
  if (transcript !== undefined) parts.push({ type: "text", text: transcript });
  const lastParts = toParts([conversation[lastIndex]!]);
  if (lastParts.length === 0) {
    throw new BadRequestError("the last message must carry some content");
  }
  parts.push(...lastParts);

  const toolSection = renderToolSection(options.tools, options.toolChoice);
  if (toolSection !== undefined) system.push(toolSection);

  return {
    system: system.length > 0 ? system.join("\n\n") : undefined,
    parts,
  };
}

/** Renders the turns before the final user message as a role-labeled transcript. */
function flattenTranscript(
  conversation: ChatCompletionMessage[],
  lastUserIndex: number,
): string | undefined {
  if (lastUserIndex === 0) return undefined;
  const transcript = conversation
    .slice(0, lastUserIndex)
    .map(transcriptText)
    .filter((text) => text.length > 0)
    .join("\n\n");
  return transcript.length > 0 ? transcript : undefined;
}

/** Renders a single conversation turn as a transcript line with role markers. */
function transcriptText(message: ChatCompletionMessage): string {
  const text = contentText(message) ?? "";
  switch (message.role) {
    case "user":
      return text.length > 0 ? `user: ${text}` : "user:";
    case "assistant": {
      const lines: string[] = [];
      if (text.length > 0) lines.push(`assistant: ${text}`);
      for (const call of toolCallsOf(message)) lines.push(call);
      return lines.join("\n");
    }
    case "tool":
      return `tool${message.tool_call_id ? ` (${message.tool_call_id})` : ""}: ${text}`;
    default:
      return "";
  }
}

/** Renders the tool calls attached to an assistant message as emulated blocks. */
function toolCallsOf(message: ChatCompletionMessage): string[] {
  const lines: string[] = [];
  for (const call of message.tool_calls ?? []) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    const name = typeof fn.name === "string" ? fn.name : "function";
    const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
    const id = typeof call.id === "string" ? call.id : undefined;
    const payload: Record<string, string> = { name, arguments: args };
    if (id !== undefined) payload.id = id;
    lines.push(`<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`);
  }
  return lines;
}

function isSystemRole(role: ChatCompletionMessage["role"] | undefined): boolean {
  return role === "system" || role === "developer";
}

/** Extracts the text content of a message, joining array text parts with newlines. */
function contentText(message: ChatCompletionMessage): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const texts: string[] = [];
    for (const contentPart of message.content) {
      if (
        isRecord(contentPart) &&
        contentPart.type === "text" &&
        typeof contentPart.text === "string"
      ) {
        texts.push(contentPart.text);
      }
    }
    return texts.join("\n");
  }
  return undefined;
}

/**
 * Converts opencode token counters into OpenAI usage accounting.
 *
 * Prompt tokens count input plus all cache reads and writes; completion
 * tokens count output plus reasoning.
 */
export function toUsage(info: AssistantMessage): ChatCompletionUsage {
  const { input, output, reasoning, cache } = info.tokens;
  const promptTokens = input + cache.read + cache.write;
  const completionTokens = output + reasoning;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/** Maps an opencode finish reason onto the OpenAI vocabulary. */
export function mapFinishReason(finish: string | undefined): ChatCompletionFinishReason {
  switch (finish) {
    case "max_tokens":
      return "length";
    case "tool_calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

/**
 * Assembles a non-streaming OpenAI chat completion from an opencode session.
 *
 * Only text parts contribute to the assistant message; reasoning and other
 * part kinds are excluded from the visible content. Emulated tool call blocks
 * are stripped from the content and surfaced as `tool_calls` instead, in which
 * case the finish reason becomes `tool_calls` and an empty content is null.
 */
export function buildCompletion(
  request: ChatCompletionRequest,
  info: AssistantMessage,
  parts: Part[],
): ChatCompletion {
  const raw = parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
  const { content, calls } = splitToolCalls(raw);
  const toolCalls = calls.map(toToolCall);
  const message: ChatCompletionResponseMessage = {
    role: "assistant",
    content: content.length > 0 || toolCalls.length === 0 ? content : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(info.finish),
        logprobs: null,
      },
    ],
    usage: toUsage(info),
  };
}

/** Converts a parsed tool call into the OpenAI wire shape with a fresh id. */
function toToolCall(call: ParsedToolCall): ChatCompletionToolCall {
  return {
    id: newToolCallId(),
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}

/**
 * Translates an error from the opencode client into an HTTP ApiError.
 *
 * Handles SDK error envelopes, transport failures (mapped to 502), and named
 * error objects; anything unrecognized falls back to a 500.
 */
export function mapOpencodeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    if (isRecord(error.cause) && isRecord(error.cause.body)) {
      return mapOpencodeError(error.cause.body);
    }
    return new BadGatewayError(`cannot reach the opencode server: ${error.message}`);
  }
  if (isRecord(error) && typeof error.name === "string") {
    const message = messageOf(error.data) ?? String(error.message ?? error.name);
    switch (error.name) {
      case "BadRequest":
        return new BadRequestError(message);
      case "NotFoundError":
        return new NotFoundError(message);
      case "UnauthorizedError":
      case "AuthError":
        return new UnauthorizedError(message);
      default:
        return new InternalServerError(message);
    }
  }
  return new InternalServerError("an error occurred while talking to the opencode server");
}

/** Maps a session-level failure to a 502, falling back to a generic message. */
function mapSessionError(error: unknown): ApiError {
  const message = isRecord(error) ? messageOf(error.data) : undefined;
  return new BadGatewayError(message ?? "the opencode session failed");
}

export class OpencodeChatCompletionsService implements ChatCompletionsService {
  readonly #client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.#client = client;
  }

  async create(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const model = parseModel(request.model);
    const input = toPrompt(request.messages, {
      tools: request.tools,
      toolChoice: request.tool_choice,
    });

    let session: { id: string };
    try {
      session = (await this.#client.session.create<true>({})).data;
    } catch (error) {
      throw mapOpencodeError(error);
    }

    let streamReturned = false;
    try {
      if (request.stream) {
        const events = await this.#client.event.subscribe();
        const prompt = this.#client.session.promptAsync<true>({
          path: { id: session.id },
          body: { model, system: input.system, parts: input.parts },
        });
        streamReturned = true;
        return {
          stream: true,
          value: this.#streamCompletion(request, session.id, events.stream, prompt),
        };
      }
      const result = await this.#client.session.prompt<true>({
        path: { id: session.id },
        body: { model, system: input.system, parts: input.parts },
      });
      if (result.data.info.error) throw mapSessionError(result.data.info.error);
      return {
        stream: false,
        value: buildCompletion(request, result.data.info, result.data.parts),
      };
    } catch (error) {
      throw mapOpencodeError(error);
    } finally {
      if (!streamReturned) await this.#deleteSession(session.id);
    }
  }

  async *#streamCompletion(
    request: ChatCompletionRequest,
    sessionID: string,
    stream: AsyncIterable<Event>,
    prompt: Promise<unknown>,
  ): AsyncGenerator<ChatCompletionChunk> {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const includeUsage = request.stream_options?.include_usage ?? false;
    const seen = new Map<string, string>();
    const splitter = new ToolCallSplitter();
    let toolCallIndex = 0;
    let finished = false;
    let error: unknown = null;
    const nextToolCallIndex = () => toolCallIndex++;

    yield {
      ...chunkBase(request, id),
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    };

    try {
      for await (const event of stream) {
        const sessionIDOfEvent = sessionIDOf(event);
        if (sessionIDOfEvent !== undefined && sessionIDOfEvent !== sessionID) continue;

        if (event.type === "session.idle") {
          finished = true;
          break;
        }
        if (event.type === "session.error") {
          throw mapSessionError(event.properties.error);
        }
        if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (part.type !== "text") continue;
          const delta = textDelta(part, event.properties.delta, seen);
          if (!delta) continue;
          for (const output of splitter.push(delta)) {
            yield this.#streamChunk(request, id, output, nextToolCallIndex);
          }
        } else if (event.type === "message.updated") {
          const info = event.properties.info;
          if (info.role !== "assistant" || info.time.completed === undefined) continue;
          for (const output of splitter.flush()) {
            yield this.#streamChunk(request, id, output, nextToolCallIndex);
          }
          yield {
            ...chunkBase(request, id),
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: toolCallIndex > 0 ? "tool_calls" : mapFinishReason(info.finish),
                logprobs: null,
              },
            ],
          };
          if (includeUsage) {
            yield { ...chunkBase(request, id), choices: [], usage: toUsage(info) };
          }
        }
      }
      if (!finished && error === null) {
        throw new BadGatewayError("opencode event stream ended before the session completed");
      }
    } catch (caught) {
      error = caught;
    } finally {
      try {
        await prompt;
      } catch (caught) {
        error ??= caught;
      }
      await this.#deleteSession(sessionID);
    }
    if (error !== null) throw error;
  }

  /**
   * Turns one splitter output into a single chunk: content text for non-call
   * spans, or a complete `tool_calls` delta for a finished call block.
   */
  #streamChunk(
    request: ChatCompletionRequest,
    id: string,
    output: SplitterOutput,
    nextIndex: () => number,
  ): ChatCompletionChunk {
    if (output.kind === "text") {
      return {
        ...chunkBase(request, id),
        choices: [
          { index: 0, delta: { content: output.text }, finish_reason: null, logprobs: null },
        ],
      };
    }
    const call = parseToolCallPayload(output.payload);
    if (call === null) {
      return {
        ...chunkBase(request, id),
        choices: [
          { index: 0, delta: { content: output.payload }, finish_reason: null, logprobs: null },
        ],
      };
    }
    return {
      ...chunkBase(request, id),
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: nextIndex(),
                id: newToolCallId(),
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    };
  }

  async #deleteSession(sessionID: string): Promise<void> {
    try {
      await this.#client.session.delete<true>({ path: { id: sessionID } });
    } catch {
      // Best effort cleanup; the session may already be gone.
    }
  }
}

function chunkBase(
  request: ChatCompletionRequest,
  id: string,
): Omit<ChatCompletionChunk, "choices" | "usage"> {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
  };
}

/**
 * Computes the content delta for a part update.
 *
 * Prefers the event's delta when provided; otherwise diffs the part's new
 * text against what has already been emitted for it.
 */
function textDelta(part: TextPart, delta: string | undefined, seen: Map<string, string>): string {
  const previous = seen.get(part.id) ?? "";
  seen.set(part.id, part.text);
  if (delta !== undefined) return delta;
  return part.text.slice(previous.length);
}

/** Extracts the session id an event belongs to, if the event carries one. */
function sessionIDOf(event: Event): string | undefined {
  switch (event.type) {
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "message.updated":
      return event.properties.info.sessionID;
    default:
      return (event.properties as { sessionID?: string }).sessionID;
  }
}

/** Type guard for plain (non-array) objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the `message` field of an error payload, if present. */
function messageOf(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return undefined;
}

/** Returns the MIME type of a data URL, falling back to octet-stream for plain URLs. */
function mimeFromUrl(url: string): string {
  const data = /^data:([^;,]+)/.exec(url);
  if (data?.[1]) return data[1];
  return "application/octet-stream";
}
