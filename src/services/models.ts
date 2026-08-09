import type { ModelsList } from "../openai/models.ts";

export interface ModelsService {
  list(): Promise<ModelsList>;
}
