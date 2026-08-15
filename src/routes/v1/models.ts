import { sendJson } from "../../http/json.ts";
import type { RouteHandler } from "../../router.ts";
import type { EmbeddingsService } from "../../services/embeddings.ts";
import type { ModelsService } from "../../services/models.ts";

export function modelsHandler(
  service: ModelsService,
  embeddingsService?: EmbeddingsService,
): RouteHandler {
  return async (_request, _server) => {
    const list = await service.list();

    if (!embeddingsService) {
      return sendJson(200, list);
    }

    return sendJson(200, {
      ...list,
      data: augmentWithEmbeddings(list.data, embeddingsService.modelName),
    });
  };
}

function augmentWithEmbeddings(
  data: Array<{ id: string }>,
  embeddingsModelId: string,
) {
  if (data.some((m) => m.id === embeddingsModelId)) {
    return data;
  }

  const ownedBy = embeddingsModelId.includes("/")
    ? embeddingsModelId.split("/")[0]
    : embeddingsModelId;

  return [
    ...data,
    {
      id: embeddingsModelId,
      object: "model",
      created: 1700000000,
      owned_by: ownedBy,
    },
  ];
}