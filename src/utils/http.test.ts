import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { BadRequestError } from "../http/errors.ts";
import { formatValidationError, parseJsonBody, streamWithDone } from "./http.ts";

describe("parseJsonBody", () => {
  test("parses a valid JSON body", async () => {
    const request = new Request("http://localhost/", {
      method: "POST",
      body: '{"a":1}',
    });
    expect(await parseJsonBody(request)).toEqual({ a: 1 });
  });

  test("throws BadRequestError for invalid JSON", async () => {
    const request = new Request("http://localhost/", { method: "POST", body: "nope" });
    expect(parseJsonBody(request)).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("formatValidationError", () => {
  test("joins issues as path: message", () => {
    const result = z.object({ a: z.string(), "nested.value": z.number() }).safeParse({ a: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatValidationError(result.error.issues)).toBe(
        "a: Invalid input: expected string, received number; nested.value: Invalid input: expected number, received undefined",
      );
    }
  });
});

describe("streamWithDone", () => {
  test("yields chunks followed by SSE_DONE", async () => {
    const chunks: unknown[] = [];
    for await (const chunk of streamWithDone(events())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["a", { b: 2 }, "[DONE]"]);
  });
});

async function* events(): AsyncGenerator<unknown> {
  yield "a";
  yield { b: 2 };
}
