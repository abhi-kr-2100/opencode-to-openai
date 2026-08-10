import { parseHttpUrl } from "./utils/net.ts";

export interface Config {
  host: string;
  port: number;
  opencodeUrl: string | null;
  embeddingsModel: string;
  embeddingsPreload: boolean;
}

const DEFAULT_EMBEDDINGS_MODEL = "Xenova/bge-small-en-v1.5";

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT?.trim() || 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid PORT "${env.PORT}": expected an integer between 0 and 65535`);
  }
  const rawOpencodeUrl = env.OPENCODE_URL?.trim();
  const opencodeUrl = rawOpencodeUrl || null;
  if (opencodeUrl && !parseHttpUrl(opencodeUrl)) {
    throw new Error(`invalid OPENCODE_URL "${opencodeUrl}": expected an absolute http(s) URL`);
  }
  const embeddingsModel = env.EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDINGS_MODEL;
  const preloadVal = env.EMBEDDINGS_PRELOAD?.trim()?.toLowerCase();
  let embeddingsPreload = false;
  if (preloadVal === "true") {
    embeddingsPreload = true;
  } else if (preloadVal && preloadVal !== "false") {
    throw new Error(
      `invalid EMBEDDINGS_PRELOAD "${env.EMBEDDINGS_PRELOAD}": expected "true" or "false"`,
    );
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    opencodeUrl,
    embeddingsModel,
    embeddingsPreload,
  };
}
