import type { ModelsList } from "../../openai/models.ts";
import type { OpencodeClient } from "../../opencode/client.ts";
import type { ModelsService } from "../models.ts";
import { mapOpencodeError } from "./errors.ts";

export class OpencodeModelsService implements ModelsService {
  readonly #client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.#client = client;
  }

  async list(): Promise<ModelsList> {
    try {
      const response = await this.#client.config.providers<true>({});
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
