import type { ErrorBody } from "../openai/error.ts";
import { sendJson } from "./json.ts";

export interface ApiErrorOptions {
  type?: string;
  code?: string | null;
  param?: string | null;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = options.type ?? "invalid_request_error";
    this.code = options.code ?? null;
    this.param = options.param ?? null;
    this.headers = { ...options.headers };
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super(400, message, { type: "invalid_request_error", ...options });
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super(401, message, {
      type: "invalid_request_error",
      code: "invalid_api_key",
      headers: { "www-authenticate": "Bearer" },
      ...options,
    });
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super(404, message, { type: "invalid_request_error", code: "not_found", ...options });
  }
}

export class MethodNotAllowedError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super(405, message, { type: "invalid_request_error", code: "method_not_allowed", ...options });
  }
}

export class InternalServerError extends ApiError {
  constructor(message = "an internal error occurred", options: ApiErrorOptions = {}) {
    super(500, message, { type: "server_error", code: "internal_server_error", ...options });
  }
}

export class NotImplementedError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super(501, message, { type: "server_error", code: "not_implemented", ...options });
  }
}

export function toErrorBody(error: ApiError): ErrorBody {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  };
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return sendJson(error.status, toErrorBody(error), error.headers);
  }
  console.error("unhandled error", error);
  return sendJson(500, toErrorBody(new InternalServerError()));
}
