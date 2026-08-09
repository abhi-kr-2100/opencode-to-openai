import { parseHttpUrl } from "./utils/net.ts";

export interface Config {
  host: string;
  port: number;
  opencodeUrl: string;
  embeddingsModel: string;
  embeddingsPreload: boolean;
}

const DEFAULT_OPENCODE_URL = "http://localhost:4096";
const DEFAULT_EMBEDDINGS_MODEL = "Xenova/bge-small-en-v1.5";

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT?.trim() || 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid PORT "${env.PORT}": expected an integer between 0 and 65535`);
  }
  const opencodeUrl = env.OPENCODE_URL?.trim() || DEFAULT_OPENCODE_URL;
  if (!parseHttpUrl(opencodeUrl)) {
    throw new Error(`invalid OPENCODE_URL "${opencodeUrl}": expected an absolute http(s) URL`);
  }

  const embeddingsModel = env.EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDINGS_MODEL;
  const preloadStr = env.EMBEDDINGS_PRELOAD?.trim().toLowerCase();
  const embeddingsPreload = preloadStr === "true" || preloadStr === "1";

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    opencodeUrl,
    embeddingsModel,
    embeddingsPreload,
  };
}
