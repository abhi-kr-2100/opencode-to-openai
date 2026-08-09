import { afterEach } from "bun:test";
import { buildRouter } from "../../../src/app.ts";
import { createServer } from "../../../src/server.ts";
import type { ChatCompletionsService } from "../../../src/services/chat-completions.ts";
import type { EmbeddingsService } from "../../../src/services/embeddings.ts";

export interface TestServer {
  baseUrl: string;
  stop(): void;
}

export interface StartServerOptions {
  chatCompletions: ChatCompletionsService;
  embeddings?: EmbeddingsService;
}

const runningServers: TestServer[] = [];

afterEach(() => {
  while (runningServers.length > 0) {
    runningServers.pop()!.stop();
  }
});

const dummyEmbeddings: EmbeddingsService = {
  create: async () => {
    return {
      object: "list",
      data: [],
      model: "dummy",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  },
};

/**
 * Boots the real application stack (Bun.serve + Router + handlers) on an
 * ephemeral port and registers it for automatic shutdown after each test.
 */
export function startServer(options: StartServerOptions): TestServer {
  const router = buildRouter(options.chatCompletions, options.embeddings ?? dummyEmbeddings);
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      opencodeUrl: "http://localhost:4096",
      embeddingsModel: "dummy",
      embeddingsPreload: false,
    },
    router,
  );
  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
  };
  runningServers.push(testServer);
  return testServer;
}
