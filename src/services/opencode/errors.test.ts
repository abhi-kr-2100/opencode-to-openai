import { describe, expect, test } from "bun:test";
import {
  ApiError,
  BadGatewayError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../http/errors.ts";
import { mapOpencodeError, mapSessionError } from "./errors.ts";

describe("mapOpencodeError", () => {
  test("maps the envelope status and message", () => {
    const error = mapOpencodeError(
      new Error("bad messages", {
        cause: { body: { name: "BadRequest", data: { message: "bad messages" } }, status: 400 },
      }),
    );
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error.status).toBe(400);
    expect(error.message).toBe("bad messages");
  });

  test("maps 401 and 404 envelopes to their classes", () => {
    const notFound = mapOpencodeError(new Error("nope", { cause: { status: 404 } }));
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(notFound.status).toBe(404);
    const unauthorized = mapOpencodeError(new Error("denied", { cause: { status: 401 } }));
    expect(unauthorized).toBeInstanceOf(UnauthorizedError);
    expect(unauthorized.status).toBe(401);
  });

  test("falls back to the wrapped message for body-less responses", () => {
    const error = mapOpencodeError(new Error("the server crashed", { cause: { status: 503 } }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(503);
    expect(error.message).toBe("the server crashed");
    expect(error.type).toBe("server_error");
  });

  test("maps connection failures to 502", () => {
    const error = mapOpencodeError(new TypeError("fetch failed"));
    expect(error.status).toBe(502);
    expect(error.code).toBe("bad_gateway");
  });

  test("maps transport failures to 502", () => {
    const error = mapOpencodeError(new Error("Unable to connect."));
    expect(error.status).toBe(502);
    expect(error.code).toBe("bad_gateway");
  });

  test("passes through ApiErrors", () => {
    const error = mapOpencodeError(new BadGatewayError("upstream down"));
    expect(error.status).toBe(502);
  });

  test("falls back for anything else", () => {
    expect(mapOpencodeError("oops").status).toBe(500);
    expect(mapOpencodeError(42).status).toBe(500);
    expect(mapOpencodeError({ name: 42 }).status).toBe(500);
  });
});

describe("mapSessionError", () => {
  test("maps session failures to 502 with their message", () => {
    const error = mapSessionError({ name: "UnknownError", data: { message: "boom" } });
    expect(error.status).toBe(502);
    expect(error.message).toBe("boom");
  });

  test("falls back for message-less failures", () => {
    const error = mapSessionError({ name: "MessageOutputLengthError", data: {} });
    expect(error.status).toBe(502);
    expect(error.message).toBe("the opencode session failed");
  });
});
