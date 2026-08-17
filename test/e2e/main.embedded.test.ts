import { createOpencodeServer, type ServerOptions } from "@opencode-ai/sdk";
import { describe, expect, test } from "bun:test";

describe("src/main.ts", () => {
  test.serial(
    "boot() embeds a real opencode server when opencodeUrl is unset and closes it on stop",
    async () => {
      let embedded: { url: string; close(): void } | null = null;
      const { boot } = await import("../../src/main.ts");
      const result = await boot(true, {
        config: ["--port", "0", "--host", "127.0.0.1"],
        createOpencodeServer: async (options: ServerOptions) => {
          const real = await createOpencodeServer(options);
          embedded = real;
          return real;
        },
      });
      expect(result).not.toBeNull();
      expect(embedded).not.toBeNull();
      const server = result!.server;
      expect(server.port).toBeGreaterThan(0);
      server.stop();
      await expectConnectionClosed(embedded!.url);
    },
  );
});

describe("src/main.ts cleanup", () => {
  test.serial(
    "start() closes the embedded opencode server when createServer fails after it is created",
    async () => {
      const blocker = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("occupied"),
      });
      let closeCalls = 0;
      try {
        const { start } = await import("../../src/main.ts");
        expect(
          start({
            config: ["--port", String(blocker.port), "--host", "127.0.0.1"],
            createOpencodeServer: async () => ({
              url: "http://127.0.0.1:59999",
              close: () => {
                closeCalls += 1;
              },
            }),
          }),
        ).rejects.toThrow();
        expect(closeCalls).toBe(1);
      } finally {
        blocker.stop();
      }
    },
  );
});

async function expectConnectionClosed(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`embedded opencode server at ${url} still accepting connections after stop()`);
}
