import { createOpencodeServer } from "@opencode-ai/sdk";
import { buildRouter } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createOpencodeHttpClient } from "./opencode/client.ts";
import { createServer } from "./server.ts";
import { OpencodeChatCompletionsService } from "./services/opencode/service.ts";
import { displayAddress } from "./utils/net.ts";

const config = loadConfig();

let opencodeUrl = config.opencodeUrl;
let opencodeServer: Awaited<ReturnType<typeof createOpencodeServer>> | null = null;

if (!process.env.OPENCODE_URL) {
  opencodeServer = await createOpencodeServer({ port: 0, timeout: 30_000 });
  opencodeUrl = opencodeServer.url;
}

const opencodeClient = createOpencodeHttpClient(opencodeUrl);
const chatCompletions = new OpencodeChatCompletionsService(opencodeClient);

const router = buildRouter(chatCompletions);
const server = createServer(config, router);
console.log(
  `opencode-to-openai listening on http://${displayAddress(server.hostname ?? config.host)}:${server.port}`,
);
console.log(`using opencode server at ${opencodeUrl}`);

if (opencodeServer) {
  const cleanup = () => {
    opencodeServer?.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
