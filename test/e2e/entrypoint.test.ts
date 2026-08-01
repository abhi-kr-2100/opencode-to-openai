import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatCompletion } from "../../src/openai/chat-completions.ts";
import { E2E_MODEL, startOpencode, type TestOpencode } from "./support/opencode.ts";
import { postJson } from "./support/requests.ts";

describe("e2e entrypoint", () => {
  let opencode: TestOpencode;

  beforeAll(async () => {
    opencode = await startOpencode();
  }, 30_000);

  afterAll(() => {
    opencode.close();
  });

  test(
    "boots src/main.ts and serves a completion from the real opencode server",
    async () => {
      const proc = Bun.spawn([process.execPath, "src/main.ts"], {
        env: { ...process.env, PORT: "0", OPENCODE_URL: opencode.url },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
      const log = await readLogUntil(proc.stdout, /using opencode server at http:\/\//, 10_000);
      const match = /listening on http:\/\/([^:]+):(\d+)/.exec(log);
      expect(match).not.toBeNull();
      expect(log).toContain(`using opencode server at ${opencode.url}`);
        const port = Number(match![2]);
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/chat/completions`,
          postJson({
            model: E2E_MODEL,
            messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as ChatCompletion;
        expect(typeof body.choices[0]?.message.content).toBe("string");
        expect(body.choices[0]?.message.content?.length).toBeGreaterThan(0);
      } finally {
        proc.kill();
        await proc.exited;
      }
    },
    { timeout: 60_000 },
  );
});

async function readLogUntil(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = (await Promise.race([
      reader.read(),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), deadline - Date.now()),
      ),
    ])) as { done?: boolean; value?: Uint8Array } | { timedOut: true };
    if ("timedOut" in result) {
      await reader.cancel();
      throw new Error(`timed out waiting for output matching ${pattern}; got: ${text}`);
    }
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (pattern.test(text)) break;
  }
  return text + decoder.decode();
}
