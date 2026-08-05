import {
  ApiError,
  BadGatewayError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "../../http/errors.ts";
import { isRecord, messageOf } from "./guards.ts";

/**
 * Translates an error from the opencode client into an HTTP ApiError.
 *
 * Handles SDK error envelopes, transport failures (mapped to 502), and named
 * error objects; anything unrecognized falls back to a 500.
 */
export function mapOpencodeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    if (isRecord(error.cause) && isRecord(error.cause.body)) {
      return mapOpencodeError(error.cause.body);
    }
    return new BadGatewayError(`cannot reach the opencode server: ${error.message}`);
  }
  if (isRecord(error) && typeof error.name === "string") {
    const message = messageOf(error.data) ?? String(error.message ?? error.name);
    switch (error.name) {
      case "BadRequest":
        return new BadRequestError(message);
      case "NotFoundError":
        return new NotFoundError(message);
      case "UnauthorizedError":
      case "AuthError":
        return new UnauthorizedError(message);
      default:
        return new InternalServerError(message);
    }
  }
  return new InternalServerError("an error occurred while talking to the opencode server");
}

/** Maps a session-level failure to a 502, falling back to a generic message. */
export function mapSessionError(error: unknown): ApiError {
  const message = isRecord(error) ? messageOf(error.data) : undefined;
  return new BadGatewayError(message ?? "the opencode session failed");
}
