import type { ModelsList } from "../../openai/models.ts";
import { createOpencodeHttpClient, type OpencodeClient } from "../../opencode/client.ts";
import type { ModelsService, ModelsServiceOptions } from "../models.ts";
import { mapOpencodeError } from "./errors.ts";

export class OpencodeModelsService implements ModelsService {
  readonly #client: OpencodeClient;
  readonly #baseUrl?: string;

  constructor(client: OpencodeClient, options?: { baseUrl?: string }) {
    this.#client = client;
    this.#baseUrl = options?.baseUrl;
  }

  async list(options?: ModelsServiceOptions): Promise<ModelsList> {
    const client = options?.password && this.#baseUrl
      ? createOpencodeHttpClient(this.#baseUrl, { password: options.password })
      : this.#client;

    try {
      const response = await client.config.providers<true>({});
      const modelsList: ModelsList = {
        object: "list",
        data: [],
      };

      const providers = response.data.providers;
      for (const provider of providers) {
        const providerID = provider.id;
        const models = provider.models ?? {};
        for (const [modelID] of Object.entries(models)) {
          const openAiModelId = `${providerID}/${modelID}`;
          modelsList.data.push({
            id: openAiModelId,
            object: "model",
            created: 1700000000,
            owned_by: providerID,
          });
        }
      }

      return modelsList;
    } catch (error) {
      throw mapOpencodeError(error);
    }
  }
}
