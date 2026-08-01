import { buildRouter } from "./app.ts";
import { displayAddress, loadConfig } from "./config.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const server = createServer(config, buildRouter());
console.log(
  `opencode-to-openai listening on http://${displayAddress(server.hostname)}:${server.port}`,
);
