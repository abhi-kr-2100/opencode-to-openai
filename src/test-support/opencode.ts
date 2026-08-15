import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssistantMessage,
  Session,
  SessionPromptData,
  SessionPromptResponse,
} from "@opencode-ai/sdk";
import type { ChatCompletionRequest } from "@/openai/chat-completions.ts";
import type { OpencodeClient } from "@/opencode/client.ts";

export enum StreamMode {
  Streaming = "streaming",
  NonStreaming = "non-streaming",
}

interface OkResult<T> {
  data: T;
}

interface ErrorResult {
  error: unknown;
}

/** A value the fake resolves as-is, or an error wrapper it rethrows. */
type FakeResult<T> = OkResult<T> | ErrorResult;

function isErrorResult(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && "error" in value;
}

async function resolve<T>(value: OkResult<T> | ErrorResult | Promise<T>): Promise<OkResult<T>> {
  if (isErrorResult(value)) throw value.error;
  const data = value instanceof Promise ? await value : value.data;
  return { data };
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

export interface CreateSessionOptions {
  query?: {
    directory?: string;
  };
}

export interface ScratchAgentSnapshot {
  path: string;
  content: string;
}

interface FakeClient extends OpencodeClient {
  calls: { method: "prompt"; body: SessionPromptData["body"] }[];
  createCalls: CreateSessionOptions[];
  scratchAgents: ScratchAgentSnapshot[];
  deleted: boolean;
}

export function fakeClient(
  overrides: {
    create?: FakeResult<Pick<Session, "id">>;
    prompt?: FakeResult<SessionPromptResponse>;
    delete?: FakeResult<boolean>;
  } = {},
): FakeClient {
  const calls: FakeClient["calls"] = [];
  const createCalls: CreateSessionOptions[] = [];
  const scratchAgents: ScratchAgentSnapshot[] = [];
  let deleted = false;
  return {
    calls,
    createCalls,
    scratchAgents,
    get deleted() {
      return deleted;
    },
    session: {
      create: async (options: CreateSessionOptions = {}) => {
        createCalls.push(options);
        if (!options.query?.directory || !(await directoryExists(options.query.directory))) {
          throw new Error(
            "fakeClient: expected a directory that exists on disk when creating a session",
          );
        }
        const scratchPath = join(options.query.directory, ".opencode", "agents", "scratch.md");
        const content = await readFile(scratchPath, "utf8");
        scratchAgents.push({ path: scratchPath, content });
        return resolve(overrides.create ?? { data: { id: "session-1" } });
      },
      prompt: async (options: { body: SessionPromptData["body"] }) => {
        calls.push({ method: "prompt", body: options.body });
        if (overrides.prompt === undefined) {
          throw new Error("fakeClient: overrides.prompt is required to call session.prompt");
        }
        return resolve(overrides.prompt);
      },
      delete: async () => {
        deleted = true;
        return resolve(overrides.delete ?? { data: true });
      },
    },
  } as unknown as FakeClient;
}

export function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "message-1",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 0, completed: 1 },
    parentID: "user-1",
    modelID: "claude-3-5-sonnet-20241022",
    providerID: "anthropic",
    mode: "primary",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    ...overrides,
  };
}

export function completionRequest(stream: StreamMode): ChatCompletionRequest {
  return {
    model: "anthropic/claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: "hi" }],
    stream: stream === StreamMode.Streaming,
  };
}
