import { buildRouter } from "./app.ts";
import { displayAddress, loadConfig } from "./config.ts";
import { createOpencodeHttpClient } from "./opencode/client.ts";
import { createServer } from "./server.ts";
import { OpencodeChatCompletionsService } from "./services/opencode-chat-completions.ts";

const config = loadConfig();

const opencodeClient = createOpencodeHttpClient(config.opencodeUrl);
const chatCompletions = new OpencodeChatCompletionsService(opencodeClient);

const router = buildRouter(chatCompletions);
const server = createServer(config, router);
console.log(
  `opencode-to-openai listening on http://${displayAddress(server.hostname ?? config.host)}:${server.port}`,
);
console.log(`using opencode server at ${config.opencodeUrl}`);
