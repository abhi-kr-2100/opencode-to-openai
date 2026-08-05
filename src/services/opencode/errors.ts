import {
  ApiError,
  BadGatewayError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "../../http/errors.ts";
import { isRecord, messageOf } from "./guards.ts";

/** Builds the ApiError subclass matching an HTTP status. */
function toApiError(status: number, message: string): ApiError {
  if (status === 400) return new BadRequestError(message);
  if (status === 401) return new UnauthorizedError(message);
  if (status === 404) return new NotFoundError(message);
  if (status >= 500) return new ApiError(status, message, { type: "server_error" });
  return new ApiError(status, message);
}

/**
 * Translates an error from the opencode client into an HTTP ApiError.
 *
 * The SDK is used with `throwOnError: true`, and its `wrapClientError`
 * interceptor guarantees the shape of everything it throws: a non-2xx
 * response arrives as an `Error` whose `cause` carries `{ body, status }`
 * and whose `message` already holds the failure text; a transport failure
 * is a plain `Error`. This mapper trusts that contract.
 */
export function mapOpencodeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    if (isRecord(error.cause) && typeof error.cause.status === "number") {
      return toApiError(error.cause.status, error.message);
    }
    return new BadGatewayError(`cannot reach the opencode server: ${error.message}`);
  }
  return new InternalServerError("an error occurred while talking to the opencode server");
}

/** Session failures are `{ name, data }` records; the message lives in `data.message`. */
export function mapSessionError(error: unknown): ApiError {
  const message = isRecord(error) ? messageOf(error.data) : undefined;
  return new BadGatewayError(message ?? "the opencode session failed");
}
