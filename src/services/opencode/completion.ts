import type { AssistantMessage, Part, TextPart } from "@opencode-ai/sdk";
import type {
  ChatCompletion,
  ChatCompletionFinishReason,
  ChatCompletionRequest,
  ChatCompletionResponseMessage,
  ChatCompletionToolCall,
  ChatCompletionUsage,
} from "../../openai/chat-completions.ts";
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
