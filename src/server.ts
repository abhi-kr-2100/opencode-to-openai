import type { Config } from "./config.ts";
import type { Router } from "./router.ts";

export function createServer(config: Config, router: Router): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request, server) => router.handle(request, server),
  });
}
