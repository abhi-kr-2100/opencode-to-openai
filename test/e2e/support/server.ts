import { afterEach } from "bun:test";
import { buildRouter } from "../../../src/app.ts";
import { createServer } from "../../../src/server.ts";
import type { ChatCompletionsService } from "../../../src/services/chat-completions.ts";

export interface TestServer {
  baseUrl: string;
  stop(): void;
}

export interface StartServerOptions {
  chatCompletions: ChatCompletionsService;
}

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
  const router = buildRouter(options.chatCompletions);
  const server = createServer(
    { host: "127.0.0.1", port: 0, opencodeUrl: "http://localhost:4096" },
    router,
  );
  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
  };
  runningServers.push(testServer);
  return testServer;
}
