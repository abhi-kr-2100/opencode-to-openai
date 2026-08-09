import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8000,
  opencodeUrl: "http://localhost:4096",
  embeddingsModel: "Xenova/bge-small-en-v1.5",
  embeddingsPreload: false,
};

describe("loadConfig", () => {
  test("defaults host, port, and opencode url", () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
  });

  test("reads PORT, HOST, and OPENCODE_URL from env", () => {
    expect(
      loadConfig({
        PORT: "9000",
        HOST: "0.0.0.0",
        OPENCODE_URL: "http://opencode.example:7777",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 9000,
      opencodeUrl: "http://opencode.example:7777",
      embeddingsModel: "Xenova/bge-small-en-v1.5",
      embeddingsPreload: false,
    });
  });

  test("reads EMBEDDINGS_MODEL and EMBEDDINGS_PRELOAD", () => {
    expect(
      loadConfig({
        EMBEDDINGS_MODEL: " Xenova/all-MiniLM-L6-v2 ",
        EMBEDDINGS_PRELOAD: "true",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 8000,
      opencodeUrl: "http://localhost:4096",
      embeddingsModel: "Xenova/all-MiniLM-L6-v2",
      embeddingsPreload: true,
    });

    expect(
      loadConfig({
        EMBEDDINGS_PRELOAD: "1",
      }).embeddingsPreload,
    ).toBe(true);
  });

  test("trims whitespace", () => {
    expect(
      loadConfig({
        PORT: " 8123 ",
        HOST: " localhost ",
        OPENCODE_URL: " http://opencode.example:7777 ",
      }),
    ).toEqual({
      host: "localhost",
      port: 8123,
      opencodeUrl: "http://opencode.example:7777",
      embeddingsModel: "Xenova/bge-small-en-v1.5",
      embeddingsPreload: false,
    });
  });

  test("accepts boundary ports", () => {
    expect(loadConfig({ PORT: "0" }).port).toBe(0);
    expect(loadConfig({ PORT: "65535" }).port).toBe(65_535);
  });

  test("throws for a non-numeric port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/invalid PORT/);
  });

  test("throws for an out-of-range port", () => {
    expect(() => loadConfig({ PORT: "-1" })).toThrow(/invalid PORT/);
    expect(() => loadConfig({ PORT: "65536" })).toThrow(/invalid PORT/);
  });

  test("throws for a malformed OPENCODE_URL", () => {
    expect(() => loadConfig({ OPENCODE_URL: "not a url" })).toThrow(/invalid OPENCODE_URL/);
  });

  test("throws for a non-http(s) OPENCODE_URL", () => {
    expect(() => loadConfig({ OPENCODE_URL: "ftp://example.com" })).toThrow(/invalid OPENCODE_URL/);
  });
});
