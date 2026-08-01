export interface Config {
  host: string;
  port: number;
  opencodeUrl: string;
}

export function displayAddress(host: string): string {
  if (
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::0" ||
    host === "0:0:0:0:0:0:0:0"
  ) {
    return "127.0.0.1";
  }
  return host;
}

const DEFAULT_OPENCODE_URL = "http://localhost:4096";
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT?.trim() || 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid PORT "${env.PORT}": expected an integer between 0 and 65535`);
  }
  const opencodeUrl = env.OPENCODE_URL?.trim() || DEFAULT_OPENCODE_URL;
  const parsed = parseUrl(opencodeUrl);
  if (!parsed) {
    throw new Error(`invalid OPENCODE_URL "${opencodeUrl}": expected an absolute http(s) URL`);
  }
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    opencodeUrl,
  };
}

function parseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
