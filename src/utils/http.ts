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

export function formatValidationError(issues: z.ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

export async function* streamWithDone(chunks: AsyncIterable<unknown>) {
  for await (const chunk of chunks) {
    yield chunk;
  }
  yield SSE_DONE;
}
