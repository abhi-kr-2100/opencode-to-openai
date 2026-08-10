import { afterEach } from "bun:test";
import { buildRouter } from "../../../src/app.ts";
import { createServer } from "../../../src/server.ts";
import type { ChatCompletionsService } from "../../../src/services/chat-completions.ts";
import type { EmbeddingsService } from "../../../src/services/embeddings.ts";
import type { ModelsService } from "../../../src/services/models.ts";

export interface TestServer {
  baseUrl: string;
  stop(): void;
}

export interface StartServerOptions {
  chatCompletions: ChatCompletionsService;
  models: ModelsService;
  embeddings: EmbeddingsService;
}

function unusedError(name: string): never {
  throw new Error(`${name} is not exercised by this test`);
}

export const stubChatCompletions: ChatCompletionsService = {
  create: async () => {
    throw unusedError("chatCompletions");
  },
};

export const stubModels: ModelsService = {
  list: async () => {
    throw unusedError("models");
  },
};

export const stubEmbeddings: EmbeddingsService = {
  modelName: "Xenova/bge-small-en-v1.5",
  create: async () => {
    throw unusedError("embeddings");
  },
  preload: async () => {},
};

const runningServers: TestServer[] = [];

afterEach(() => {
  while (runningServers.length > 0) {
    runningServers.pop()!.stop();
  }
});

/**
 * Boots the real application stack (Bun.serve + Router + handlers) on an
 * ephemeral port and registers it for automatic shutdown after each test.
 */
export function startServer(options: StartServerOptions): TestServer {
  const router = buildRouter(options.chatCompletions, options.models, options.embeddings);
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      opencodeUrl: "http://localhost:4096",
      embeddingsModel: "Xenova/bge-small-en-v1.5",
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
