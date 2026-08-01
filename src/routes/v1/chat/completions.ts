import { BadRequestError } from "../../../http/errors.ts";
import { sendJson } from "../../../http/json.ts";
import { sseResponse } from "../../../http/sse.ts";
import { chatCompletionRequestSchema } from "../../../openai/chat-completions.ts";
import type { RouteHandler } from "../../../router.ts";
import type { ChatCompletionsService } from "../../../services/chat-completions.ts";
import { formatValidationError, parseJsonBody, streamWithDone } from "../../../utils/http.ts";

export function chatCompletionsHandler(service: ChatCompletionsService): RouteHandler {
  return async (request, server) => {
    const parsed = chatCompletionRequestSchema.safeParse(await parseJsonBody(request));
    if (!parsed.success) {
      throw new BadRequestError(formatValidationError(parsed.error.issues));
    }

    const result = await service.create(parsed.data);
    if (result.stream) {
      server.timeout(request, 0);
      return sseResponse(streamWithDone(result.value));
    }
    return sendJson(200, result.value);
  };
}
