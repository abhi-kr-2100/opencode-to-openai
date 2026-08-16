import type { AssistantMessage, Part, TextPart } from "@opencode-ai/sdk";
import { BadGatewayError } from "../../http/errors.ts";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionFinishReason,
  ChatCompletionRequest,
  ChatCompletionResponseMessage,
  ChatCompletionToolCall,
  ChatCompletionUsage,
} from "../../openai/chat-completions.ts";
import { mapSessionError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { newToolCallId, type ParsedToolCall, splitToolCalls } from "./tools.ts";

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
 * Assembles the chunks of a streaming completion.
 *
 * Streaming requests run through the non-streaming path and emit the finished
 * response whole, framed the way OpenAI frames a stream: an opening chunk
 * carrying only the assistant role with empty content, the content on its own
 * chunk, each tool call's arguments split into fragments so clients that
 * accumulate them by index still work, a terminal chunk with an empty delta and
 * the finish reason, and — when asked for — a dedicated usage-only chunk as
 * the final one.
 */
export function buildChunks(
  request: ChatCompletionRequest,
  completion: ChatCompletion,
): ChatCompletionChunk[] {
  const choice = completion.choices[0]!;
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  } as const;
  const chunks: ChatCompletionChunk[] = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
  ];
  if (choice.message.content !== null) {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: { content: choice.message.content },
          finish_reason: null,
          logprobs: null,
        },
      ],
    });
  }
  for (const [callIndex, call] of (choice.message.tool_calls ?? []).entries()) {
    const fragments = fragmentArguments(call.function.arguments);
    for (const [offset, fragment] of fragments.entries()) {
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                offset === 0
                  ? {
                      index: callIndex,
                      id: call.id,
                      type: "function",
                      function: { name: call.function.name, arguments: fragment },
                    }
                  : { index: callIndex, function: { arguments: fragment } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      });
    }
  }
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason, logprobs: null }],
  });
  if (request.stream_options?.include_usage) {
    chunks.push({ ...base, choices: [], usage: completion.usage });
  }
  return chunks;
}

/**
 * Transforms an OpenCode event stream into an OpenAI streaming completion chunk sequence.
 */
export async function* streamEventsToChunks(
  request: ChatCompletionRequest,
  sessionID: string,
  events: AsyncIterable<unknown> | Iterable<unknown>,
): AsyncGenerator<ChatCompletionChunk> {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const base = {
    id,
    object: "chat.completion.chunk" as const,
    created,
    model: request.model,
  };

  // Emit initial opening chunk carrying { role: "assistant", content: "" }
  yield {
    ...base,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };

  let accumulatedRawText = "";
  let emittedContentLength = 0;
  let assistantInfo: AssistantMessage | undefined;

  const partTextLengths = new Map<string, number>();

  for await (const rawEvent of events) {
    if (!isRecord(rawEvent)) continue;
    const type = rawEvent.type;
    const properties = isRecord(rawEvent.properties) ? rawEvent.properties : {};

    if (type === "session.error") {
      if (properties.sessionID === undefined || properties.sessionID === sessionID) {
        if (properties.error) throw mapSessionError(properties.error);
        throw new BadGatewayError("the opencode session failed");
      }
    }

    if (type === "message.part.updated") {
      const part = isRecord(properties.part) ? properties.part : null;
      if (part && part.sessionID === sessionID && part.type === "text") {
        const partID = typeof part.id === "string" ? part.id : "";
        let deltaText = typeof properties.delta === "string" ? properties.delta : "";
        const fullText = typeof part.text === "string" ? part.text : "";

        if (deltaText.length === 0 && fullText.length > 0) {
          const prevLen = partTextLengths.get(partID) ?? 0;
          if (fullText.length > prevLen) {
            deltaText = fullText.slice(prevLen);
            partTextLengths.set(partID, fullText.length);
          }
        } else if (fullText.length > 0) {
          partTextLengths.set(partID, fullText.length);
        }

        if (deltaText.length > 0) {
          accumulatedRawText += deltaText;

          if (!accumulatedRawText.includes("<tool_call>")) {
            yield {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { content: deltaText },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            };
            emittedContentLength += deltaText.length;
          }
        }
      }
    }

    if (type === "message.updated") {
      const info = isRecord(properties.info) ? properties.info : null;
      if (info && info.sessionID === sessionID && info.role === "assistant") {
        if (info.error) throw mapSessionError(info.error);
        assistantInfo = info as unknown as AssistantMessage;
      }
    }

    if (type === "session.idle") {
      if (properties.sessionID === sessionID) {
        break;
      }
    }
  }

  const { content, calls } = splitToolCalls(accumulatedRawText);

  const toolCalls = calls.map(toToolCall);
  if (toolCalls.length > 0) {
    const unEmittedContent = content.slice(emittedContentLength);
    if (unEmittedContent.length > 0) {
      yield {
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: unEmittedContent },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };
    }
    for (const [callIndex, call] of toolCalls.entries()) {
      const fragments = fragmentArguments(call.function.arguments);
      for (const [offset, fragment] of fragments.entries()) {
        yield {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  offset === 0
                    ? {
                        index: callIndex,
                        id: call.id,
                        type: "function",
                        function: { name: call.function.name, arguments: fragment },
                      }
                    : { index: callIndex, function: { arguments: fragment } },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
      }
    }
  } else {
    const unEmittedContent = accumulatedRawText.slice(emittedContentLength);
    if (unEmittedContent.length > 0) {
      yield {
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: unEmittedContent },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };
    }
  }

  const finishReason: ChatCompletionFinishReason =
    toolCalls.length > 0 ? "tool_calls" : mapFinishReason(assistantInfo?.finish);

  yield {
    ...base,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  };

  if (request.stream_options?.include_usage && assistantInfo) {
    yield {
      ...base,
      choices: [],
      usage: toUsage(assistantInfo),
    };
  }
}

/** The longest `arguments` snippet a single tool-call frame may carry. */
const ARGUMENT_FRAGMENT_SIZE = 24;

/**
 * Splits serialized tool call arguments into pieces small enough that each
 * travels in its own chunk, mirroring how OpenAI streams arguments incrementally.
 * Clients rebuild the payload by concatenating the pieces for a call's index.
 */
function fragmentArguments(raw: string): string[] {
  if (raw.length === 0) return [""];
  const fragments: string[] = [];
  for (let offset = 0; offset < raw.length; offset += ARGUMENT_FRAGMENT_SIZE) {
    fragments.push(raw.slice(offset, offset + ARGUMENT_FRAGMENT_SIZE));
  }
  return fragments;
}
