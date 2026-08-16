import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionRequest } from "../../openai/chat-completions.ts";
import type { OpencodeClient } from "../../opencode/client.ts";
import type { ChatCompletionResult, ChatCompletionsService } from "../chat-completions.ts";
import { buildCompletion, streamEventsToChunks } from "./completion.ts";
import { mapOpencodeError, mapSessionError } from "./errors.ts";
import { parseModel } from "./model.ts";
import { toPrompt } from "./prompt.ts";

/** The opencode agent every request runs as. */
const AGENT = "scratch";

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
    let isStreamingOwned = false;

    try {
      await this.#writeScratchAgent(tmpDir, {
        temperature: request.temperature,
        topP: request.top_p,
      });

      try {
        session = (
          await this.#client.session.create<true>({
            query: { directory: tmpDir },
          })
        ).data;
      } catch (error) {
        throw mapOpencodeError(error);
      }

      if (request.stream) {
        let eventsResult;
        try {
          eventsResult = await this.#client.event.subscribe<true>({
            query: { directory: tmpDir },
          });
        } catch (error) {
          throw mapOpencodeError(error);
        }

        try {
          await this.#client.session.promptAsync<true>({
            path: { id: session.id },
            body: { model, agent: AGENT, system: input.system, parts: input.parts },
          });
        } catch (error) {
          throw mapOpencodeError(error);
        }

        const sessionId = session.id;
        isStreamingOwned = true;

        const streamChunks = async function* (this: OpencodeChatCompletionsService) {
          try {
            yield* streamEventsToChunks(request, sessionId, eventsResult.stream);
          } finally {
            await this.#cleanupTmpDir(tmpDir);
            await this.#deleteSession(sessionId);
          }
        }.bind(this);

        return {
          stream: true,
          value: streamChunks(),
        };
      }

      try {
        const result = await this.#client.session.prompt<true>({
          path: { id: session.id },
          body: { model, agent: AGENT, system: input.system, parts: input.parts },
        });
        if (result.data.info.error) throw mapSessionError(result.data.info.error);
        const completion = buildCompletion(request, result.data.info, result.data.parts);
        return { stream: false, value: completion };
      } catch (error) {
        throw mapOpencodeError(error);
      }
    } finally {
      if (!isStreamingOwned) {
        await this.#cleanupTmpDir(tmpDir);
        if (session) {
          await this.#deleteSession(session.id);
        }
      }
    }
  }

  async #writeScratchAgent(
    dirPath: string,
    options: { temperature?: number; topP?: number } = {},
  ): Promise<void> {
    const agentsDir = join(dirPath, ".opencode", "agents");
    await mkdir(agentsDir, { recursive: true });
    // The body must survive the loader's `.trim()` and stay truthy, or
    // opencode's `agent.prompt ?` check falls back to its heavy base prompt.
    const frontmatter = [
      "description: A scratch agent with a minimal prompt and all tools denied.",
      "mode: primary",
      ...(options.temperature !== undefined ? [`temperature: ${options.temperature}`] : []),
      ...(options.topP !== undefined ? [`top_p: ${options.topP}`] : []),
      "permission:",
      '  "*": deny',
    ].join("\n");
    await writeFile(join(agentsDir, "scratch.md"), `---\n${frontmatter}\n---\n.\n`);
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
