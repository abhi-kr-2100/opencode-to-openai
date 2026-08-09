import { describe, expect, test } from "bun:test";

describe("src/main.ts", () => {
  test("boot() skips the server when not run as the entrypoint", async () => {
    const { boot } = await import("./main.ts");
    expect(boot(false)).toBeNull();
  });

  test("boot() starts the full application stack when run as the entrypoint", async () => {
    const previousPort = process.env.PORT;
    const previousHost = process.env.HOST;
    process.env.PORT = "0";
    process.env.HOST = "127.0.0.1";
    try {
      const { boot } = await import("./main.ts");
      const server = boot(true);
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
    }
  });
});
