import { buildRouter } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createOpencodeHttpClient } from "./opencode/client.ts";
import { createServer } from "./server.ts";
import { LocalEmbeddingsService } from "./services/embeddings.ts";
import { OpencodeChatCompletionsService } from "./services/opencode/service.ts";
import { displayAddress } from "./utils/net.ts";

const config = loadConfig();

const opencodeClient = createOpencodeHttpClient(config.opencodeUrl);
const chatCompletions = new OpencodeChatCompletionsService(opencodeClient);
const embeddings = new LocalEmbeddingsService(config.embeddingsModel, config.embeddingsPreload);

const router = buildRouter(chatCompletions, embeddings);
const server = createServer(config, router);
console.log(
  `opencode-to-openai listening on http://${displayAddress(server.hostname ?? config.host)}:${server.port}`,
);
console.log(`using opencode server at ${config.opencodeUrl}`);
