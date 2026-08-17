import type { ModelsList } from "../openai/models.ts";

export interface ModelsServiceOptions {
  password?: string | null;
}

export interface ModelsService {
  list(options?: ModelsServiceOptions): Promise<ModelsList>;
}
