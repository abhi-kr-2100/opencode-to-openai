import { createOpencodeServer, type ServerOptions } from "@opencode-ai/sdk";
import { buildRouter } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createOpencodeHttpClient } from "./opencode/client.ts";
import { createServer } from "./server.ts";
import {
  HuggingFaceEmbeddingsService,
  type FeatureExtractionPipeline,
} from "./services/embeddings.ts";
import { OpencodeModelsService } from "./services/opencode/models.ts";
import { OpencodeChatCompletionsService } from "./services/opencode/service.ts";
import { displayAddress } from "./utils/net.ts";

export interface StartOptions {
  createOpencodeServer?: (options: ServerOptions) => Promise<{ url: string; close(): void }>;
  buildEmbeddingsPipeline?: FeatureExtractionPipeline;
}

export interface StartResult {
  server: ReturnType<typeof Bun.serve>;
}

export async function start(options: StartOptions = {}): Promise<StartResult> {
  const config = loadConfig();
  const createEmbeddedServer = options.createOpencodeServer ?? createOpencodeServer;

  let opencodeUrl = config.opencodeUrl;
  let opencodeServer: { url: string; close(): void } | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  if (!opencodeUrl) {
    opencodeServer = await createEmbeddedServer({ port: 0 });
    opencodeUrl = opencodeServer.url;
  }

  try {
    const opencodeClient = createOpencodeHttpClient(opencodeUrl, {
      password: config.opencodePassword,
    });
    const chatCompletions = new OpencodeChatCompletionsService(opencodeClient, {
      baseUrl: opencodeUrl,
    });
    const models = new OpencodeModelsService(opencodeClient, { baseUrl: opencodeUrl });

    const embeddings = new HuggingFaceEmbeddingsService(
      config.embeddingsModel,
      options.buildEmbeddingsPipeline,
    );

    if (config.embeddingsPreload) {
      console.log(`preloading embeddings model: ${config.embeddingsModel}`);
      await embeddings.preload();
    }

    const router = buildRouter(chatCompletions, models, embeddings);

    server = createServer(config, router);
    console.log(
      `opencode-to-openai listening on http://${displayAddress(server.hostname ?? config.host)}:${server.port}`,
    );
    const opencodeOrigin = new URL(opencodeUrl).origin;
    console.log(`using opencode server at ${opencodeOrigin}`);

    if (opencodeServer) {
      const originalStop = server.stop;
      server.stop = (closeActiveConnections?: boolean) => {
        const stopResult = originalStop.call(server, closeActiveConnections);
        opencodeServer!.close();
        return stopResult;
      };
    }

    return { server };
  } catch (error) {
    server?.stop();
    opencodeServer?.close();
    throw error;
  }
}

export async function boot(
  main: boolean = import.meta.main,
  options: StartOptions = {},
): Promise<StartResult | null> {
  if (!main) {
    return null;
  }
  return start(options);
}

await boot();
