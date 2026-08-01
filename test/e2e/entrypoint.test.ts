import { describe, expect, test } from "bun:test";
import { postJson } from "./support/requests.ts";

describe("e2e entrypoint", () => {
  test("boots src/main.ts and serves requests over real HTTP", async () => {
    const proc = Bun.spawn([process.execPath, "src/main.ts"], {
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
    });
    try {
      const log = await readLogUntil(proc.stdout, /listening on http:\/\//, 5_000);
      const match = /listening on http:\/\/([^:]+):(\d+)/.exec(log);
      expect(match).not.toBeNull();
      const port = Number(match![2]);
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        postJson({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      );
      expect(response.status).toBe(501);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
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
