export function displayAddress(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "::0" || host === "0:0:0:0:0:0:0:0") {
    return "127.0.0.1";
  }
  return host;
}

export function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
