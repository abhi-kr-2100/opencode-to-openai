import { Router } from "./router.ts";
import { chatCompletionsHandler } from "./routes/v1/chat/completions.ts";
import { StubChatCompletionsService } from "./services/chat-completions.ts";
import type { ChatCompletionsService } from "./services/chat-completions.ts";

export function buildRouter(
  chatCompletions: ChatCompletionsService = new StubChatCompletionsService(),
): Router {
  const router = new Router();
  router.register("POST", "/v1/chat/completions", chatCompletionsHandler(chatCompletions));
  return router;
}
