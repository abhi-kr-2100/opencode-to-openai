import { describe, expect, test } from "bun:test";
import { createOpencodeHttpClient } from "./client.ts";

describe("createOpencodeHttpClient", () => {
  test("creates client without auth header when password is not provided", () => {
    const client = createOpencodeHttpClient("http://localhost:4096");
    expect(client).toBeDefined();
  });

  test("attaches Bearer auth header when password is provided", () => {
    const password = "my-secret-password";
    const client = createOpencodeHttpClient("http://localhost:4096", { password });
    expect(client).toBeDefined();

    const expectedAuth = `Bearer ${password}`;
    expect(expectedAuth).toBe("Bearer my-secret-password");
  });
});
