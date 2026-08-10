import { createOpencodeServer, type ServerOptions } from "@opencode-ai/sdk";
import { describe, expect, test } from "bun:test";

describe("src/main.ts", () => {
  test.serial(
    "boot() embeds a real opencode server when OPENCODE_URL is unset and closes it on stop",
    async () => {
      const previousPort = process.env.PORT;
      const previousHost = process.env.HOST;
      const previousOpencodeUrl = process.env.OPENCODE_URL;
      process.env.PORT = "0";
      process.env.HOST = "127.0.0.1";
      delete process.env.OPENCODE_URL;
      try {
        let embedded: { url: string; close(): void } | null = null;
        const { boot } = await import("../../src/main.ts");
        const server = await boot(true, {
          createOpencodeServer: async (options: ServerOptions) => {
            const real = await createOpencodeServer(options);
            embedded = real;
            return real;
          },
        });
        expect(server).not.toBeNull();
        expect(embedded).not.toBeNull();
        expect(server!.port).toBeGreaterThan(0);
        server!.stop();
        await expectConnectionClosed(embedded!.url);
      } finally {
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
        if (previousHost === undefined) delete process.env.HOST;
        else process.env.HOST = previousHost;
        if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
        else process.env.OPENCODE_URL = previousOpencodeUrl;
      }
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
      const previousPort = process.env.PORT;
      const previousHost = process.env.HOST;
      const previousOpencodeUrl = process.env.OPENCODE_URL;
      let closeCalls = 0;
      try {
        process.env.PORT = String(blocker.port);
        process.env.HOST = "127.0.0.1";
        delete process.env.OPENCODE_URL;

        const { start } = await import("../../src/main.ts");
        expect(
          start({
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
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
        if (previousHost === undefined) delete process.env.HOST;
        else process.env.HOST = previousHost;
        if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
        else process.env.OPENCODE_URL = previousOpencodeUrl;
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
