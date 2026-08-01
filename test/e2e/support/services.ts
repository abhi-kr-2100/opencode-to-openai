import type { ChatCompletionRequest } from "../../../src/openai/chat-completions.ts";
import type {
  ChatCompletionsService,
  ChatCompletionResult,
} from "../../../src/services/chat-completions.ts";

export class FakeChatCompletionsService implements ChatCompletionsService {
  constructor(
    private readonly result: (request: ChatCompletionRequest) => ChatCompletionResult,
  ) {}

  async create(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.result(request);
  }
}
