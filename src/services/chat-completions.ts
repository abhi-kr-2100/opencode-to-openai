import { NotImplementedError } from "../http/errors.ts";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "../openai/chat-completions.ts";

// Single seam for both response modes: the service decides based on request.stream.
// Streaming is an async iterable of chunks; the transport layer frames it as SSE.
export type ChatCompletionResult =
  | { stream: false; value: ChatCompletion }
  | { stream: true; value: AsyncIterable<ChatCompletionChunk> };

export interface ChatCompletionsService {
  create(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

// Placeholder until the opencode backend is wired in.
export class StubChatCompletionsService implements ChatCompletionsService {
  // oxlint-disable-next-line no-useless-constructor -- explicit so coverage counts it
  constructor() {}

  async create(_request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    throw new NotImplementedError("chat completions are not implemented yet");
  }
}
