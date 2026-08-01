import { createOpencodeClient } from "@opencode-ai/sdk";

export type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export function createOpencodeHttpClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({ baseUrl, throwOnError: true });
}
