import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8000,
  opencodeUrl: null,
  embeddingsModel: "Xenova/bge-small-en-v1.5",
  embeddingsPreload: false,
};

describe("loadConfig", () => {
  test("defaults host, port, and opencode url when no args or config file exist", () => {
    expect(loadConfig([])).toEqual(DEFAULTS);
  });

  test("reads CLI flags", () => {
    expect(
      loadConfig([
        "--port",
        "9000",
        "--host",
        "0.0.0.0",
        "--opencode-url",
        "http://opencode.example:7777",
        "--embeddings-model",
        "Xenova/all-MiniLM-L6-v2",
        "--embeddings-preload",
        "true",
      ]),
    ).toEqual({
      host: "0.0.0.0",
      port: 9000,
      opencodeUrl: "http://opencode.example:7777",
      embeddingsModel: "Xenova/all-MiniLM-L6-v2",
      embeddingsPreload: true,
    });
  });

  test("trims whitespace from string CLI flags", () => {
    expect(
      loadConfig([
        "--port",
        " 8123 ",
        "--host",
        " localhost ",
        "--opencode-url",
        " http://opencode.example:7777 ",
        "--embeddings-model",
        " Xenova/all-MiniLM-L6-v2 ",
        "--embeddings-preload",
        " true ",
      ]),
    ).toEqual({
      host: "localhost",
      port: 8123,
      opencodeUrl: "http://opencode.example:7777",
      embeddingsModel: "Xenova/all-MiniLM-L6-v2",
      embeddingsPreload: true,
    });
  });

  test("accepts boundary ports", () => {
    expect(loadConfig(["--port", "0"]).port).toBe(0);
    expect(loadConfig(["--port", "65535"]).port).toBe(65_535);
  });

  test("throws for a non-numeric port in CLI args", () => {
    expect(() => loadConfig(["--port", "abc"])).toThrow(/invalid port/);
  });

  test("throws for an out-of-range port in CLI args", () => {
    expect(() => loadConfig(["--port=65536"])).toThrow(/invalid port/);
  });

  test("throws for a malformed opencode-url", () => {
    expect(() => loadConfig(["--opencode-url", "not a url"])).toThrow(/invalid opencodeUrl/);
  });

  test("throws for a non-http(s) opencode-url", () => {
    expect(() => loadConfig(["--opencode-url", "ftp://example.com"])).toThrow(
      /invalid opencodeUrl/,
    );
  });

  test("reads embeddings-preload false", () => {
    expect(loadConfig(["--embeddings-preload", "false"]).embeddingsPreload).toBe(false);
  });

  test("throws for non-boolean embeddings-preload values", () => {
    for (const value of ["1", "0", "yes", "no", "on", "y", "n", " random "]) {
      expect(() => loadConfig(["--embeddings-preload", value])).toThrow(
        /invalid embeddingsPreload/,
      );
    }
  });

  test("accepts case-insensitive embeddings-preload booleans", () => {
    expect(loadConfig(["--embeddings-preload", "TRUE"]).embeddingsPreload).toBe(true);
    expect(loadConfig(["--embeddings-preload", "False"]).embeddingsPreload).toBe(false);
  });

  test("loads configuration from custom JSON config file", () => {
    const tmpDir = join(process.cwd(), ".tmp-config-test-1");
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, "custom.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        host: "10.0.0.1",
        port: 4000,
        opencodeUrl: "http://10.0.0.1:4096",
        embeddingsModel: "custom-model",
        embeddingsPreload: true,
      }),
      "utf8",
    );

    try {
      expect(loadConfig({ configFilePath: configPath, args: [] })).toEqual({
        host: "10.0.0.1",
        port: 4000,
        opencodeUrl: "http://10.0.0.1:4096",
        embeddingsModel: "custom-model",
        embeddingsPreload: true,
      });

      expect(loadConfig(["--config", configPath])).toEqual({
        host: "10.0.0.1",
        port: 4000,
        opencodeUrl: "http://10.0.0.1:4096",
        embeddingsModel: "custom-model",
        embeddingsPreload: true,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI flags take precedence over config file values", () => {
    const tmpDir = join(process.cwd(), ".tmp-config-test-2");
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, "custom.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        host: "10.0.0.1",
        port: 4000,
        opencodeUrl: "http://10.0.0.1:4096",
        embeddingsModel: "file-model",
        embeddingsPreload: false,
      }),
      "utf8",
    );

    try {
      const config = loadConfig([
        "--config",
        configPath,
        "--port",
        "5000",
        "--embeddings-model",
        "cli-model",
        "--embeddings-preload",
        "true",
      ]);

      expect(config).toEqual({
        host: "10.0.0.1",
        port: 5000,
        opencodeUrl: "http://10.0.0.1:4096",
        embeddingsModel: "cli-model",
        embeddingsPreload: true,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws on invalid JSON in config file", () => {
    const tmpDir = join(process.cwd(), ".tmp-config-test-3");
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, "bad.json");
    writeFileSync(configPath, "{ invalid json", "utf8");

    try {
      expect(() => loadConfig(["--config", configPath])).toThrow(/invalid JSON in config file/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
