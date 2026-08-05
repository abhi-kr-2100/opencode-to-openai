import { describe, expect, test } from "bun:test";
import { BadGatewayError, NotFoundError, UnauthorizedError } from "../../http/errors.ts";
import { mapOpencodeError } from "./errors.ts";

describe("mapOpencodeError", () => {
  test("maps opencode server errors", () => {
    const error = mapOpencodeError({ name: "BadRequest", data: { message: "bad messages" } });
    expect(error.status).toBe(400);
    expect(error.message).toBe("bad messages");
  });

  test("maps not found and auth errors", () => {
    const notFound = mapOpencodeError({ name: "NotFoundError", data: {} });
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(notFound.status).toBe(404);
    const unauthorized = mapOpencodeError({ name: "UnauthorizedError", data: {} });
    expect(unauthorized).toBeInstanceOf(UnauthorizedError);
    expect(unauthorized.status).toBe(401);
    const auth = mapOpencodeError({ name: "AuthError", data: {} });
    expect(auth.status).toBe(401);
  });

  test("maps unknown named errors to 500 with their message", () => {
    const error = mapOpencodeError({ name: "UnknownError", data: { message: "boom" } });
    expect(error.status).toBe(500);
    expect(error.message).toBe("boom");
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

  test("unwraps the SDK error envelope before mapping", () => {
    const error = mapOpencodeError(
      new Error("bad messages", {
        cause: { body: { name: "BadRequest", data: { message: "bad messages" } } },
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toBe("bad messages");
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
