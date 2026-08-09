import { Router } from "./router.ts";
import { chatCompletionsHandler } from "./routes/v1/chat/completions.ts";
import { embeddingsHandler } from "./routes/v1/embeddings.ts";
import type { ChatCompletionsService } from "./services/chat-completions.ts";
import type { EmbeddingsService } from "./services/embeddings.ts";

export function buildRouter(
  chatCompletions: ChatCompletionsService,
  embeddings: EmbeddingsService,
): Router {
  const router = new Router();
  router.register("POST", "/v1/chat/completions", chatCompletionsHandler(chatCompletions));
  router.register("POST", "/v1/embeddings", embeddingsHandler(embeddings));
  return router;
}
