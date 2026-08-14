import { describe, expect, test } from "bun:test";
import type { StartOptions } from "./main.ts";
import { createRecordingPipeline } from "./testing/recordingPipeline.ts";
import type { FeatureExtractor, FeatureExtractionPipeline } from "./services/embeddings.ts";

const stubPipelineExtractor: FeatureExtractor = async (inputs) => ({
  tolist: () => (Array.isArray(inputs) ? inputs : [inputs]).map(() => [0.5, 0.5, 0.5, 0.5]),
});
stubPipelineExtractor.tokenizer = {
  encode: (text: string) => Array.from({ length: text.split(" ").length }, () => 0),
  decode: (tokenIds: number[]) => tokenIds.join(" "),
};

const stubEmbeddingsPipeline: FeatureExtractionPipeline = async () => stubPipelineExtractor;

const stubEmbeddedServer: StartOptions["createOpencodeServer"] = async () => ({
  url: "http://127.0.0.1:4096",
  close: () => {},
});

describe("src/main.ts", () => {
  test("boot() skips the server when not run as the entrypoint", async () => {
    const { boot } = await import("./main.ts");
    expect(await boot(false)).toBeNull();
  });

  test.serial("boot() starts the full application stack when run as the entrypoint", async () => {
    const previousPort = process.env.PORT;
    const previousHost = process.env.HOST;
    const previousOpencodeUrl = process.env.OPENCODE_URL;
    process.env.PORT = "0";
    process.env.HOST = "127.0.0.1";
    process.env.OPENCODE_URL = "http://localhost:4096";
    try {
      const { boot } = await import("./main.ts");
      const result = await boot(true);
      expect(result).not.toBeNull();
      const server = result!.server;
      try {
        expect(server.port).toBeGreaterThan(0);
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/does-not-exist`);
        expect(response.status).toBe(404);
      } finally {
        server.stop();
      }
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
      if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
      else process.env.OPENCODE_URL = previousOpencodeUrl;
    }
  });

  test.serial(
    "boot() embeds a mocked server for a whitespace-only OPENCODE_URL and closes it on stop",
    async () => {
      const previousPort = process.env.PORT;
      const previousHost = process.env.HOST;
      const previousOpencodeUrl = process.env.OPENCODE_URL;
      let closeCalls = 0;
      try {
        process.env.PORT = "0";
        process.env.HOST = "127.0.0.1";
        process.env.OPENCODE_URL = "   ";
        const { boot } = await import("./main.ts");
        const result = await boot(true, {
          createOpencodeServer: async () => ({
            url: "http://127.0.0.1:4096",
            close: () => {
              closeCalls += 1;
            },
          }),
        });
        expect(result).not.toBeNull();
        const server = result!.server;
        expect(server.port).toBeGreaterThan(0);
        server.stop();
        expect(closeCalls).toBe(1);
      } finally {
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
        if (previousHost === undefined) delete process.env.HOST;
        else process.env.HOST = previousHost;
        if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
        else process.env.OPENCODE_URL = previousOpencodeUrl;
      }
    },
  );

  test.serial(
    "start() closes the embedded server and rethrows when a later step fails",
    async () => {
      const previousPort = process.env.PORT;
      const previousHost = process.env.HOST;
      const previousOpencodeUrl = process.env.OPENCODE_URL;
      let closeCalls = 0;
      try {
        process.env.PORT = "0";
        process.env.HOST = "127.0.0.1";
        process.env.OPENCODE_URL = "   ";
        const { start } = await import("./main.ts");
        const error = await start({
          createOpencodeServer: async () => ({
            url: "invalid-url",
            close: () => {
              closeCalls += 1;
            },
          }),
        }).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(closeCalls).toBe(1);
      } finally {
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
        if (previousHost === undefined) delete process.env.HOST;
        else process.env.HOST = previousHost;
        if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
        else process.env.OPENCODE_URL = previousOpencodeUrl;
      }
    },
  );

  test.serial("start() closes the Bun server when a later step fails", async () => {
    const previousPort = process.env.PORT;
    const previousHost = process.env.HOST;
    const previousOpencodeUrl = process.env.OPENCODE_URL;
    const originalServe = Bun.serve;
    let stopCalls = 0;
    try {
      process.env.PORT = "0";
      process.env.HOST = "127.0.0.1";
      process.env.OPENCODE_URL = "   ";
      Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
        const server = originalServe(options);
        const originalStop = server.stop;
        server.stop = ((closeActiveConnections?: boolean) => {
          stopCalls += 1;
          return originalStop.call(server, closeActiveConnections);
        }) as typeof server.stop;
        return server;
      }) as typeof Bun.serve;
      const { start } = await import("./main.ts");
      expect(
        start({
          createOpencodeServer: async () => ({
            url: "invalid-url",
            close: () => {},
          }),
        }),
      ).rejects.toThrow();
      expect(stopCalls).toBe(1);
    } finally {
      Bun.serve = originalServe;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
      if (previousOpencodeUrl === undefined) delete process.env.OPENCODE_URL;
      else process.env.OPENCODE_URL = previousOpencodeUrl;
    }
  });

  test.serial(
    "start() preloads the embeddings model before exposing the server when EMBEDDINGS_PRELOAD is enabled",
    async () => {
      const previousPort = process.env.PORT;
      const previousHost = process.env.HOST;
      const previousModel = process.env.EMBEDDINGS_MODEL;
      const previousPreload = process.env.EMBEDDINGS_PRELOAD;
      process.env.PORT = "0";
      process.env.HOST = "127.0.0.1";
      process.env.EMBEDDINGS_MODEL = "test-model";
      process.env.EMBEDDINGS_PRELOAD = "true";
      try {
        const recording = createRecordingPipeline(stubEmbeddingsPipeline);
        const { start } = await import("./main.ts");
        const { server } = await start({
          createOpencodeServer: stubEmbeddedServer,
          buildEmbeddingsPipeline: recording.pipeline,
        });
        try {
          expect(server.port).toBeGreaterThan(0);
          expect(recording.calls).toHaveLength(1);
          expect(recording.calls[0]).toEqual({
            task: "feature-extraction",
            model: "test-model",
            options: { dtype: "q8" },
          });
        } finally {
          server.stop();
        }
      } finally {
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
        if (previousHost === undefined) delete process.env.HOST;
        else process.env.HOST = previousHost;
        if (previousModel === undefined) delete process.env.EMBEDDINGS_MODEL;
        else process.env.EMBEDDINGS_MODEL = previousModel;
        if (previousPreload === undefined) delete process.env.EMBEDDINGS_PRELOAD;
        else process.env.EMBEDDINGS_PRELOAD = previousPreload;
      }
    },
  );

  test.serial("start() rejects and closes the embedded server when the preload fails", async () => {
    const previousPort = process.env.PORT;
    const previousHost = process.env.HOST;
    const previousModel = process.env.EMBEDDINGS_MODEL;
    const previousPreload = process.env.EMBEDDINGS_PRELOAD;
    let closeCalls = 0;
    process.env.PORT = "0";
    process.env.HOST = "127.0.0.1";
    process.env.EMBEDDINGS_MODEL = "test-model";
    process.env.EMBEDDINGS_PRELOAD = "true";
    try {
      const recording = createRecordingPipeline(async () => {
        throw new Error("download failed");
      });
      const { start } = await import("./main.ts");
      const error = await start({
        createOpencodeServer: async () => ({
          url: "http://127.0.0.1:4096",
          close: () => {
            closeCalls += 1;
          },
        }),
        buildEmbeddingsPipeline: recording.pipeline,
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("download failed");
      expect(recording.calls).toHaveLength(1);
      expect(closeCalls).toBe(1);
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
      if (previousModel === undefined) delete process.env.EMBEDDINGS_MODEL;
      else process.env.EMBEDDINGS_MODEL = previousModel;
      if (previousPreload === undefined) delete process.env.EMBEDDINGS_PRELOAD;
      else process.env.EMBEDDINGS_PRELOAD = previousPreload;
    }
  });
});
