import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseHttpUrl } from "./utils/net.ts";
import { parseBoolean } from "./utils/parse.ts";

export interface Config {
  host: string;
  port: number;
  opencodeUrl: string | null;
  embeddingsModel: string;
  embeddingsPreload: boolean;
}

export interface LoadConfigOptions {
  args?: string[];
  configFilePath?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8000;
const DEFAULT_OPENCODE_URL = null;
const DEFAULT_EMBEDDINGS_MODEL = "Xenova/bge-small-en-v1.5";
const DEFAULT_EMBEDDINGS_PRELOAD = false;

interface RawFileConfig {
  host?: unknown;
  port?: unknown;
  opencodeUrl?: unknown;
  opencode_url?: unknown;
  embeddingsModel?: unknown;
  embeddings_model?: unknown;
  embeddingsPreload?: unknown;
  embeddings_preload?: unknown;
}

function parseJsonConfig(path: string): RawFileConfig {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`failed to read config file "${path}": ${(error as Error).message}`, {
      cause: error,
    });
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object at root");
    }
    return parsed as RawFileConfig;
  } catch (error) {
    throw new Error(`invalid JSON in config file "${path}": ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export function loadConfig(options: LoadConfigOptions | string[] = {}): Config {
  const argsList = Array.isArray(options) ? options : (options.args ?? process.argv.slice(2));

  const { values: parsedFlags } = parseArgs({
    args: argsList,
    options: {
      config: { type: "string", short: "c" },
      host: { type: "string" },
      port: { type: "string" },
      "opencode-url": { type: "string" },
      "embeddings-model": { type: "string" },
      "embeddings-preload": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const explicitConfigPath =
    parsedFlags.config || (!Array.isArray(options) ? options.configFilePath : undefined);

  let fileConfig: RawFileConfig = {};
  if (explicitConfigPath) {
    fileConfig = parseJsonConfig(explicitConfigPath);
  } else if (existsSync("config.json")) {
    fileConfig = parseJsonConfig("config.json");
  }

  // Merging logic: CLI flags > File Config > Defaults

  // 1. Host
  const rawHost = parsedFlags.host ?? fileConfig.host;
  let host = DEFAULT_HOST;
  if (rawHost !== undefined && rawHost !== null) {
    if (typeof rawHost !== "string") {
      throw new Error(`invalid host in config file: expected string`);
    }
    const trimmed = rawHost.trim();
    if (trimmed.length === 0) {
      throw new Error(`invalid host: expected non-empty string`);
    }
    host = trimmed;
  }

  // 2. Port
  const rawPort = parsedFlags.port ?? fileConfig.port;
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== null) {
    const numPort =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string"
          ? Number(rawPort.trim())
          : NaN;

    if (!Number.isInteger(numPort) || numPort < 0 || numPort > 65_535) {
      throw new Error(`invalid port "${rawPort}": expected an integer between 0 and 65535`);
    }
    port = numPort;
  }

  // 3. Opencode URL
  const rawOpencodeUrl =
    parsedFlags["opencode-url"] ?? fileConfig.opencodeUrl ?? fileConfig.opencode_url;
  let opencodeUrl: string | null = DEFAULT_OPENCODE_URL;
  if (rawOpencodeUrl !== undefined && rawOpencodeUrl !== null) {
    if (typeof rawOpencodeUrl !== "string") {
      throw new Error(`invalid opencodeUrl in config file: expected string`);
    }
    const trimmed = rawOpencodeUrl.trim();
    if (trimmed.length > 0) {
      if (!parseHttpUrl(trimmed)) {
        throw new Error(`invalid opencodeUrl "${trimmed}": expected an absolute http(s) URL`);
      }
      opencodeUrl = trimmed;
    }
  }

  // 4. Embeddings Model
  const rawEmbeddingsModel =
    parsedFlags["embeddings-model"] ?? fileConfig.embeddingsModel ?? fileConfig.embeddings_model;
  let embeddingsModel = DEFAULT_EMBEDDINGS_MODEL;
  if (rawEmbeddingsModel !== undefined && rawEmbeddingsModel !== null) {
    if (typeof rawEmbeddingsModel !== "string") {
      throw new Error(`invalid embeddingsModel in config file: expected string`);
    }
    const trimmed = rawEmbeddingsModel.trim();
    if (trimmed.length === 0) {
      throw new Error(`invalid embeddingsModel: expected non-empty string`);
    }
    embeddingsModel = trimmed;
  }

  // 5. Embeddings Preload
  const rawEmbeddingsPreload =
    parsedFlags["embeddings-preload"] ??
    fileConfig.embeddingsPreload ??
    fileConfig.embeddings_preload;
  let embeddingsPreload = DEFAULT_EMBEDDINGS_PRELOAD;
  if (rawEmbeddingsPreload !== undefined && rawEmbeddingsPreload !== null) {
    if (typeof rawEmbeddingsPreload === "boolean") {
      embeddingsPreload = rawEmbeddingsPreload;
    } else if (typeof rawEmbeddingsPreload === "string") {
      const parsed = parseBoolean(rawEmbeddingsPreload.trim());
      if (parsed === undefined) {
        throw new Error(
          `invalid embeddingsPreload "${rawEmbeddingsPreload}": expected "true" or "false"`,
        );
      }
      embeddingsPreload = parsed;
    } else {
      throw new Error(
        `invalid embeddingsPreload "${rawEmbeddingsPreload}": expected boolean or "true"/"false"`,
      );
    }
  }

  return {
    host,
    port,
    opencodeUrl,
    embeddingsModel,
    embeddingsPreload,
  };
}
