import { BadRequestError } from "../../http/errors.ts";
import { sendJson } from "../../http/json.ts";
import { embeddingsRequestSchema } from "../../openai/embeddings.ts";
import type { RouteHandler } from "../../router.ts";
import type { EmbeddingsService } from "../../services/embeddings.ts";
import { formatValidationError, parseJsonBody } from "../../utils/http.ts";

export function embeddingsHandler(service: EmbeddingsService): RouteHandler {
  return async (request) => {
    const parsed = embeddingsRequestSchema.safeParse(await parseJsonBody(request));
    if (!parsed.success) {
      throw new BadRequestError(formatValidationError(parsed.error.issues));
    }

    if (parsed.data.model !== service.modelName) {
      throw new BadRequestError(
        `model "${parsed.data.model}" is not supported: configured embeddings model is "${service.modelName}"`,
      );
    }

    const result = await service.create(parsed.data);
    return sendJson(200, result);
  };
}
