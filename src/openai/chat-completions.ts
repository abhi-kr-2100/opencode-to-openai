import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).nullish(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    stream: z.boolean().default(false),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().optional(),
    response_format: z
      .object({
        type: z.enum(["text", "json_object"]),
        json_schema: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  })
  // Unknown fields are tolerated so forward-compatible OpenAI request shapes don't break us.
  .loose();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatCompletionMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRole = "system" | "developer" | "user" | "assistant" | "tool";
export type ChatCompletionFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | null;

/**
 * A tool invocation attached to an assistant message.
 *
 * `arguments` travels as a raw JSON string rather than a nested object, so
 * clients must parse it before use. The id stays stable for the whole call so
 * a client can correlate it with the tool result it sends back in a `tool`
 * message.
 */
export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A non-streaming completion response.
 *
 * The shape mirrors the OpenAI wire format exactly so OpenAI-compatible
 * clients can deserialize it without adaptation. `object` is fixed so clients
 * that also consume streaming responses can branch on message kind without
 * sniffing field presence.
 */
export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

/**
 * One of up to `n` candidate outputs for a request.
 *
 * `finish_reason` distinguishes a completed answer from a truncated one: it
 * tells the client why generation stopped, e.g. the model exhausted the stop
 * sequence, ran out of tokens, or emitted tool calls it expects the client to
 * execute before continuing. `logprobs` is always null because this server
 * never requests log probabilities, but the field is kept so clients that
 * read it unconditionally still work.
 */
export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionResponseMessage;
  finish_reason: ChatCompletionFinishReason;
  logprobs: null;
}

/**
 * The assistant's message in a completed choice.
 *
 * Unlike request messages, the role can never vary, because the server never
 * synthesizes messages from any other speaker. `content` is null when the
 * model chose to emit tool calls instead of text, so consumers must check
 * `tool_calls` before treating the message as textual; `refusal` carries the
 * model's explanation when it declined to answer.
 */
export interface ChatCompletionResponseMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ChatCompletionToolCall[];
  refusal?: string | null;
}

/**
 * Token accounting for a completed request.
 *
 * Lets clients display cost and enforce budget limits. `prompt_tokens` spans
 * every message sent in the request, not just the final one, so it is the
 * number to charge against when estimating cost per turn.
 */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * One event of a streaming completion.
 *
 * Chunks are emitted incrementally as the model generates, and no single
 * chunk is a complete message: clients must accumulate the delta fields
 * across chunks to reconstruct the full text. `usage` appears only on the
 * final chunk, and only when the client asked for it via `stream_options`.
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage;
}

/**
 * One candidate within a chunk.
 *
 * `finish_reason` is null on every chunk except the last, where it signals
 * why generation ended; clients can therefore detect the terminal chunk
 * without matching ids.
 */
export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionDelta;
  finish_reason: ChatCompletionFinishReason;
  logprobs: null;
}

/**
 * The increment of an assistant message carried by a chunk.
 *
 * A field is only present when its value changed since the previous chunk, so
 * each delta is a patch, not a snapshot: clients must merge fields across
 * consecutive chunks instead of replacing the message wholesale, or text
 * emitted in earlier chunks will be lost.
 */
export interface ChatCompletionDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: ChatCompletionToolCallDelta[];
  refusal?: string | null;
}

/**
 * An incremental update to one tool call within a delta.
 *
 * `index` identifies which tool call the update belongs to, since chunks may
 * interleave updates for several in-flight calls. `arguments` arrives split
 * across chunks as a JSON string and must be concatenated in order before it
 * can be parsed.
 */
export interface ChatCompletionToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}
