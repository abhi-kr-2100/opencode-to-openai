import type { AssistantMessage, Event, Message, Part } from "@opencode-ai/sdk";
import type { ChatCompletionRequest } from "@/openai/chat-completions.ts";
import type { OpencodeClient } from "@/opencode/client.ts";
import { OpencodeChatCompletionsService } from "@/services/opencode/service.ts";

export enum StreamMode {
  Streaming = "streaming",
  NonStreaming = "non-streaming",
}

interface ErrorResult {
  error: unknown;
}

function isErrorResult(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && "error" in value;
}

async function resolve(value: unknown): Promise<unknown> {
  if (isErrorResult(value)) throw value.error;
  return value;
}

interface FakeClient extends OpencodeClient {
  calls: { method: "prompt" | "promptAsync"; body: unknown }[];
  deleted: boolean;
}

export function fakeClient(overrides: {
  create?: unknown;
  prompt?: unknown;
  promptAsync?: unknown;
  subscribe?: AsyncGenerator<Event> | { error: unknown };
  delete?: unknown;
}): FakeClient {
  const calls: FakeClient["calls"] = [];
  let deleted = false;
  return {
    calls,
    get deleted() {
      return deleted;
    },
    session: {
      create: () => resolve(overrides.create ?? { data: { id: "session-1" } }),
      prompt: (options: unknown) => {
        calls.push({ method: "prompt", body: (options as { body: unknown }).body });
        return resolve(overrides.prompt);
      },
      promptAsync: (options: unknown) => {
        calls.push({ method: "promptAsync", body: (options as { body: unknown }).body });
        return resolve(overrides.promptAsync ?? { data: undefined });
      },
      delete: () => {
        deleted = true;
        return resolve(overrides.delete ?? { data: true });
      },
    },
    event: {
      subscribe: async () => ({
        stream: (await resolve(overrides.subscribe ?? {})) as AsyncGenerator<Event>,
      }),
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

export function textPart(text: string, id = "part-1", sessionID = "session-1"): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: { id, sessionID, messageID: "message-1", type: "text", text },
      delta: text,
    },
  };
}

export function partEvent(part: Part, delta?: string): Event {
  return { type: "message.part.updated", properties: { part, delta } };
}

export function updated(info: Message): Event {
  return { type: "message.updated", properties: { info } };
}

export function userInfo(): Message {
  return {
    id: "user-1",
    sessionID: "session-1",
    role: "user",
    time: { created: 0 },
    agent: "test",
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
  };
}

export function idle(): Event {
  return { type: "session.idle", properties: { sessionID: "session-1" } };
}

export function completionRequest(stream: StreamMode): ChatCompletionRequest {
  return {
    model: "anthropic/claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: "hi" }],
    stream: stream === StreamMode.Streaming,
  };
}

/** Runs a sequence of events through a fresh service, collecting the chunks. */
export async function collect(events: Event[], includeUsage = false) {
  const client = fakeClient({
    create: { data: { id: "session-1" } },
    subscribe: (async function* () {
      for (const event of events) yield event;
    })(),
  });
  const service = new OpencodeChatCompletionsService(client);
  const result = await service.create({
    ...completionRequest(StreamMode.Streaming),
    stream_options: { include_usage: includeUsage },
  });
  if (result.stream === false) throw new Error("expected a streaming result");
  const chunks = [];
  for await (const chunk of result.value) chunks.push(chunk);
  return chunks;
}
