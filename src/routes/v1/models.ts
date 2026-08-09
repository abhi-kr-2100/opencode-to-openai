import { sendJson } from "../../http/json.ts";
import type { RouteHandler } from "../../router.ts";
import type { ModelsService } from "../../services/models.ts";

export function modelsHandler(service: ModelsService): RouteHandler {
  return async (_request, _server) => {
    const list = await service.list();
    return sendJson(200, list);
  };
}
