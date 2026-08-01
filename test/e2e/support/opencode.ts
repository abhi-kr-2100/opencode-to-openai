import { createOpencodeServer } from "@opencode-ai/sdk";

/**
 * Model used by the e2e suite. OpenCode's built-in gateway models need no
 * API keys, so the tests work out of the box. Override with
 * E2E_OPENCODE_MODEL to test against a different provider/model.
 */
export const E2E_MODEL = process.env.E2E_OPENCODE_MODEL ?? "opencode/deepseek-v4-flash-free";

export interface TestOpencode {
  url: string;
  close(): void;
}

/**
 * Boots a real `opencode serve` process on an ephemeral port. Each test
 * file should start one in `beforeAll` and close it in `afterAll`.
 */
export async function startOpencode(): Promise<TestOpencode> {
  const server = await createOpencodeServer({ port: 0, timeout: 30_000 });
  return { url: server.url, close: () => server.close() };
}
