import { MethodNotAllowedError, NotFoundError, toErrorResponse } from "./http/errors.ts";

export interface TimeoutServer {
  timeout(request: Request, seconds: number): void;
}

export type RouteHandler = (
  request: Request,
  server: TimeoutServer,
) => Response | Promise<Response>;

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export class Router {
  readonly #routes: Route[] = [];

  // oxlint-disable-next-line no-useless-constructor -- explicit so coverage counts it
  constructor() {}

  register(method: string, path: string, handler: RouteHandler): void {
    this.#routes.push({ method: method.toUpperCase(), path, handler });
  }

  async handle(request: Request, server: TimeoutServer): Promise<Response> {
    const url = new URL(request.url);
    try {
      const route = this.#findRoute(request.method, url.pathname);
      return await route.handler(request, server);
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  #findRoute(method: string, pathname: string): Route {
    let matched: Route | null = null;
    let pathExists = false;

    let allowed = new Set();
    for (const route of this.#routes) {
      if (route.path !== pathname) continue;
      pathExists = true;
      allowed.add(route.method);
      if (route.method === method) matched = route;
    }

    if (!matched) {
      if (pathExists) {
        const allowedStr = [...allowed].join(", ");
        throw new MethodNotAllowedError(`method ${method} is not allowed for ${pathname}`, {
          headers: { allow: allowedStr },
        });
      }
      throw new NotFoundError(`no route matches ${method} ${pathname}`);
    }

    return matched;
  }
}
