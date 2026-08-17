import { createOpencodeClient } from "@opencode-ai/sdk";

export type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export interface CreateOpencodeHttpClientOptions {
  password?: string | null;
}

export function createOpencodeHttpClient(
  baseUrl: string,
  options: CreateOpencodeHttpClientOptions = {},
): OpencodeClient {
  const headers: Record<string, string> = {};
  if (options.password) {
    headers.authorization = `Bearer ${options.password}`;
  }
  return createOpencodeClient({ baseUrl, throwOnError: true, headers });
}
