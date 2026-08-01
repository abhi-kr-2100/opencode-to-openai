export interface Config {
  host: string;
  port: number;
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

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT?.trim() || 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid PORT "${env.PORT}": expected an integer between 0 and 65535`);
  }
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
  };
}
