import { describe, expect, test } from "bun:test";
import { sendJson } from "./http/json.ts";
import { Router } from "./router.ts";
import { createServer } from "./server.ts";

describe("createServer", () => {
  test("serves requests through the router", async () => {
    const router = new Router();
    router.register("GET", "/ping", () => sendJson(200, { ok: true }));
    const server = createServer(
      { host: "127.0.0.1", port: 0, opencodeUrl: "http://localhost:4096" },
      router,
    );
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/ping`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      server.stop();
    }
  });
});
