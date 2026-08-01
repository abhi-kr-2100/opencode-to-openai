import { describe, expect, test } from "bun:test";
import {
  ApiError,
  BadRequestError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  NotImplementedError,
  UnauthorizedError,
  toErrorBody,
  toErrorResponse,
} from "./errors.ts";

describe("ApiError and subclasses", () => {
  test("ApiError stores defaults", () => {
    const error = new ApiError(418, "teapot");
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(418);
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBeNull();
    expect(error.param).toBeNull();
  });

  test("ApiError accepts options", () => {
    const error = new ApiError(418, "teapot", {
      type: "t",
      code: "c",
      param: "p",
      headers: { "x-foo": "bar" },
    });
    expect(error.type).toBe("t");
    expect(error.code).toBe("c");
    expect(error.param).toBe("p");
    expect(error.headers).toEqual({ "x-foo": "bar" });
  });

  test("BadRequestError defaults", () => {
    const error = new BadRequestError("bad");
    expect(error.status).toBe(400);
    expect(error.type).toBe("invalid_request_error");
  });

  test("UnauthorizedError defaults", () => {
    const error = new UnauthorizedError("nope");
    expect(error.status).toBe(401);
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("invalid_api_key");
    expect(error.headers).toEqual({ "www-authenticate": "Bearer" });
  });

  test("NotFoundError defaults", () => {
    const error = new NotFoundError("missing");
    expect(error.status).toBe(404);
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("not_found");
  });

  test("MethodNotAllowedError defaults", () => {
    const error = new MethodNotAllowedError("nope");
    expect(error.status).toBe(405);
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("method_not_allowed");
    expect(error.headers).toEqual({});
  });

  test("InternalServerError defaults and overrides", () => {
    const error = new InternalServerError();
    expect(error.status).toBe(500);
    expect(error.message).toBe("an internal error occurred");
    expect(error.type).toBe("server_error");
    expect(error.code).toBe("internal_server_error");

    const custom = new InternalServerError("custom", { param: "p" });
    expect(custom.message).toBe("custom");
    expect(custom.param).toBe("p");
  });

  test("NotImplementedError defaults", () => {
    const error = new NotImplementedError("later");
    expect(error.status).toBe(501);
    expect(error.type).toBe("server_error");
    expect(error.code).toBe("not_implemented");
  });
});

describe("toErrorBody", () => {
  test("maps an ApiError to an OpenAI error body", () => {
    const error = new BadRequestError("oops", { code: "invalid_request_error", param: "x" });
    expect(toErrorBody(error)).toEqual({
      error: {
        message: "oops",
        type: "invalid_request_error",
        param: "x",
        code: "invalid_request_error",
      },
    });
  });
});

describe("toErrorResponse", () => {
  test("returns the ApiError status and body", async () => {
    const response = toErrorResponse(new BadRequestError("oops"));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: { message: "oops", type: "invalid_request_error", param: null, code: null },
    });
  });

  test("includes error headers in the response", async () => {
    const unauthorized = toErrorResponse(new UnauthorizedError("nope"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const methodNotAllowed = toErrorResponse(
      new MethodNotAllowedError("nope", { headers: { allow: "GET, POST" } }),
    );
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET, POST");
  });

  test("returns 500 with a generic message for unknown errors", async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const response = toErrorResponse(new Error("boom"));
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe("an internal error occurred");
    } finally {
      console.error = consoleError;
    }
  });
});
