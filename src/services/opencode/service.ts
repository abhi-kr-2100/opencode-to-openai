import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const tmpDir = await mkdtemp(join(tmpdir(), "opencode-to-openai-"));
    let session: { id: string } | undefined;

    try {
      await mkdir(join(tmpDir, ".opencode", "agents"), { recursive: true });
      await writeFile(
        join(tmpDir, ".opencode", "agents", "scratch.md"),
        `---\ndescription: Scratch agent with an empty system prompt\nmode: primary\n---\n`,
      );

      try {
        session = (
          await this.#client.session.create<true>({
            query: { directory: tmpDir },
          })
        ).data;
      } catch (error) {
        throw mapOpencodeError(error);
      }

      try {
        const result = await this.#client.session.prompt<true>({
          path: { id: session.id },
          body: { model, agent: "scratch", system: input.system, parts: input.parts },
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
      }
    } finally {
      await this.#cleanupTmpDir(tmpDir);
      if (session) {
        await this.#deleteSession(session.id);
      }
    }
  }

  async #deleteSession(sessionID: string): Promise<void> {
    try {
      await this.#client.session.delete<true>({ path: { id: sessionID } });
    } catch {
      // Best effort cleanup; the session may already be gone.
    }
  }

  async #cleanupTmpDir(dirPath: string): Promise<void> {
    try {
      await rm(dirPath, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
