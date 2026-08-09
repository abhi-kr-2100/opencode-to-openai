import { buildRouter } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createOpencodeHttpClient } from "./opencode/client.ts";
import { createServer } from "./server.ts";
import { OpencodeModelsService } from "./services/opencode/models.ts";
import { OpencodeChatCompletionsService } from "./services/opencode/service.ts";
import { displayAddress } from "./utils/net.ts";

export function start(): ReturnType<typeof Bun.serve> {
  const config = loadConfig();

  const opencodeClient = createOpencodeHttpClient(config.opencodeUrl);
  const chatCompletions = new OpencodeChatCompletionsService(opencodeClient);
  const models = new OpencodeModelsService(opencodeClient);

  const router = buildRouter(chatCompletions, models);
  const server = createServer(config, router);
  console.log(
    `opencode-to-openai listening on http://${displayAddress(server.hostname ?? config.host)}:${server.port}`,
  );
  console.log(`using opencode server at ${config.opencodeUrl}`);
  return server;
}

export function boot(main: boolean = import.meta.main): ReturnType<typeof Bun.serve> | null {
  if (!main) {
    return null;
  }
  return start();
}

boot();
