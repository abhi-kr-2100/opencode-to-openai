import { z } from "zod";
import { BadRequestError } from "../http/errors.ts";
import { SSE_DONE } from "../http/sse.ts";

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequestError("the request body is not valid JSON");
  }
}

export function formatValidationError(issues: z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization")?.trim();
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ? match[1].trim() : null;
}

export async function* streamWithDone<T>(chunks: AsyncIterable<T>): AsyncGenerator<T | string> {
  for await (const chunk of chunks) {
    yield chunk;
  }
  yield SSE_DONE;
}
