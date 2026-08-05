export interface ErrorDetail {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

/**
 * ErrorDetail describes OpenAI's error format. However,
 * the complete HTTP response contains an error field:
 * { "error": { "message": ... } }.
 */
export interface ErrorBody {
  error: ErrorDetail;
}
