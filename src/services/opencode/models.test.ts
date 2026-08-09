import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@/opencode/client.ts";
import { OpencodeModelsService } from "./models.ts";

describe("OpencodeModelsService", () => {
  test("correctly maps opencode config providers to openai models", async () => {
    const mockProvidersResponse = {
      data: {
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-3-5-sonnet-20241022": {
                id: "claude-3-5-sonnet-20241022",
                providerID: "anthropic",
                name: "Claude 3.5 Sonnet",
              },
            },
          },
          {
            id: "deepseek",
            name: "DeepSeek",
            models: {
              "deepseek-chat": {
                id: "deepseek-chat",
                providerID: "deepseek",
                name: "DeepSeek Chat",
              },
            },
          },
        ],
        default: {},
      },
    };

    const mockClient = {
      config: {
        providers: async () => mockProvidersResponse,
      },
    } as unknown as OpencodeClient;

    const service = new OpencodeModelsService(mockClient);
    const result = await service.list();

    expect(result).toEqual({
      object: "list",
      data: [
        {
          id: "anthropic/claude-3-5-sonnet-20241022",
          object: "model",
          created: 1700000000,
          owned_by: "anthropic",
        },
        {
          id: "deepseek/deepseek-chat",
          object: "model",
          created: 1700000000,
          owned_by: "deepseek",
        },
      ],
    });
  });

  test("handles empty or missing providers", async () => {
    const mockClient = {
      config: {
        providers: async () => ({ data: { providers: [], default: {} } }),
      },
    } as unknown as OpencodeClient;

    const service = new OpencodeModelsService(mockClient);
    const result = await service.list();

    expect(result).toEqual({
      object: "list",
      data: [],
    });
  });

  test("maps error using mapOpencodeError", async () => {
    const mockClient = {
      config: {
        providers: async () => {
          throw new Error("Opencode client error");
        },
      },
    } as unknown as OpencodeClient;

    const service = new OpencodeModelsService(mockClient);
    expect(service.list()).rejects.toThrow(
      "cannot reach the opencode server: Opencode client error",
    );
  });
});
