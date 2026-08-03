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
  ChatCompletionUsage,
} from "../openai/chat-completions.ts";
import type { OpencodeClient } from "../opencode/client.ts";
import type { ChatCompletionResult, ChatCompletionsService } from "./chat-completions.ts";

interface OpencodeModel {
  providerID: string;
  modelID: string;
}

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

/**
 * Maps OpenAI chat messages onto an opencode session prompt.
 *
 * Leading `system`/`developer` instructions are carried in the prompt's
 * `system` field. The final user message becomes the prompt's parts. Any
 * preceding conversation turns are flattened into a transcript text part with
 * role markers, since opencode starts from a fresh session and cannot replay
 * prior assistant turns or tool results as real session messages.
 */
export function toPrompt(messages: ChatCompletionMessage[]): PromptInput {
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
  if (lastUserIndex !== conversation.length - 1) {
    throw new BadRequestError(
      "the last message must be a user message: opencode only generates a reply to a user turn",
    );
  }

  const transcript = flattenTranscript(conversation, lastUserIndex);
  const parts: Array<TextPartInput | FilePartInput> = [];
  if (transcript !== undefined) parts.push({ type: "text", text: transcript });
  parts.push(...toParts([conversation[lastUserIndex]!]));

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

/** Renders the tool calls attached to an assistant message. */
function toolCallsOf(message: ChatCompletionMessage): string[] {
  const lines: string[] = [];
  for (const call of message.tool_calls ?? []) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    const id = typeof call.id === "string" ? call.id : "";
    const name = typeof fn.name === "string" ? fn.name : "function";
    const args = typeof fn.arguments === "string" ? fn.arguments : "";
    lines.push(`tool_call${id ? ` (${id})` : ""}: ${name}(${args})`);
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
 * part kinds are excluded from the visible content.
 */
export function buildCompletion(
  request: ChatCompletionRequest,
  info: AssistantMessage,
  parts: Part[],
): ChatCompletion {
  const content = parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: mapFinishReason(info.finish),
        logprobs: null,
      },
    ],
    usage: toUsage(info),
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
    const input = toPrompt(request.messages);

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
    let finished = false;
    let error: unknown = null;

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
          yield {
            ...chunkBase(request, id),
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null, logprobs: null }],
          };
        } else if (event.type === "message.updated") {
          const info = event.properties.info;
          if (info.role !== "assistant" || info.time.completed === undefined) continue;
          yield {
            ...chunkBase(request, id),
            choices: [
              { index: 0, delta: {}, finish_reason: mapFinishReason(info.finish), logprobs: null },
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
