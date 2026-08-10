import { describe, expect, test } from "bun:test";

describe("src/main.ts", () => {
  test("boot() skips the server when not run as the entrypoint", async () => {
    const { boot } = await import("./main.ts");
    expect(await boot(false)).toBeNull();
  });

  test.serial("boot() starts the full application stack when run as the entrypoint", async () => {
    const previousPort = process.env.PORT;
    const previousHost = process.env.HOST;
    const previousOpencodeUrl = process.env.OPENCODE_URL;
    process.env.PORT = "0";
    process.env.HOST = "127.0.0.1";
    process.env.OPENCODE_URL = "http://localhost:4096";
    try {
      const { boot } = await import("./main.ts");
      const server = await boot(true);
      expect(server).not.toBeNull();
      try {
        expect(server!.port).toBeGreaterThan(0);
        const response = await fetch(`http://127.0.0.1:${server!.port}/v1/does-not-exist`);
        expect(response.status).toBe(404);
      } finally {
        server!.stop();
      }
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
      if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
      else process.env.OPENCODE_URL = previousOpencodeUrl;
    }
  });

  test.serial("boot() embeds a mocked server for a whitespace-only OPENCODE_URL and closes it on stop", async () => {
    const previousPort = process.env.PORT;
    const previousHost = process.env.HOST;
    const previousOpencodeUrl = process.env.OPENCODE_URL;
    let closeCalls = 0;
    try {
      process.env.PORT = "0";
      process.env.HOST = "127.0.0.1";
      process.env.OPENCODE_URL = "   ";
      const { boot } = await import("./main.ts");
      const server = await boot(true, {
        createOpencodeServer: async () => ({
          url: "http://127.0.0.1:4096",
          close: () => {
            closeCalls += 1;
          },
        }),
      });
      expect(server).not.toBeNull();
      expect(server!.port).toBeGreaterThan(0);
      server!.stop();
      expect(closeCalls).toBe(1);
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
      if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
      else process.env.OPENCODE_URL = previousOpencodeUrl;
    }
  });

  test.serial("start() closes the embedded server and rethrows when a later step fails", async () => {
    const previousPort = process.env.PORT;
    const previousHost = process.env.HOST;
    const previousOpencodeUrl = process.env.OPENCODE_URL;
    let closeCalls = 0;
    try {
      process.env.PORT = "0";
      process.env.HOST = "127.0.0.1";
      process.env.OPENCODE_URL = "   ";
      const { start } = await import("./main.ts");
      const error = await start({
        createOpencodeServer: async () => ({
          url: "invalid-url",
          close: () => {
            closeCalls += 1;
          },
        }),
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(closeCalls).toBe(1);
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
      if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
      else process.env.OPENCODE_URL = previousOpencodeUrl;
    }
  });
});
