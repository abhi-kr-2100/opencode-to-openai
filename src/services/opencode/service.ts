import type { Event, TextPart } from "@opencode-ai/sdk";
import { BadGatewayError } from "../../http/errors.ts";
import type { ChatCompletionChunk, ChatCompletionRequest } from "../../openai/chat-completions.ts";
import type { OpencodeClient } from "../../opencode/client.ts";
import type { ChatCompletionResult, ChatCompletionsService } from "../chat-completions.ts";
import { buildCompletion, mapFinishReason, toUsage } from "./completion.ts";
import { mapOpencodeError, mapSessionError } from "./errors.ts";
import { parseModel } from "./model.ts";
import { toPrompt } from "./prompt.ts";
import {
  newToolCallId,
  parseToolCallPayload,
  type SplitterOutput,
  ToolCallSplitter,
} from "./tools.ts";

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
