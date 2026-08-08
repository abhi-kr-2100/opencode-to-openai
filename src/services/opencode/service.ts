import type { ChatCompletionRequest } from "../../openai/chat-completions.ts";
import type { OpencodeClient } from "../../opencode/client.ts";
import type { ChatCompletionResult, ChatCompletionsService } from "../chat-completions.ts";
import { buildChunks, buildCompletion } from "./completion.ts";
import { mapOpencodeError, mapSessionError } from "./errors.ts";
import { parseModel } from "./model.ts";
import { toPrompt } from "./prompt.ts";

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

    try {
      const result = await this.#client.session.prompt<true>({
        path: { id: session.id },
        body: { model, system: input.system, parts: input.parts },
      });
      if (result.data.info.error) throw mapSessionError(result.data.info.error);
      const completion = buildCompletion(request, result.data.info, result.data.parts);
      if (!request.stream) {
        return { stream: false, value: completion };
      }
      return {
        stream: true,
        value: (async function* () {
          yield* buildChunks(request, completion);
        })(),
      };
    } catch (error) {
      throw mapOpencodeError(error);
    } finally {
      await this.#deleteSession(session.id);
    }
  }

  async #deleteSession(sessionID: string): Promise<void> {
    try {
      await this.#client.session.delete<true>({ path: { id: sessionID } });
    } catch {
      // Best effort cleanup; the session may already be gone.
    }
  }
}
