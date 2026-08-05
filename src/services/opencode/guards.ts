/** Type guard for plain (non-array) objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the `message` field of an error payload, if present. */
export function messageOf(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return undefined;
}

/** Returns the MIME type of a data URL, falling back to octet-stream for plain URLs. */
export function mimeFromUrl(url: string): string {
  const data = /^data:([^;,]+)/.exec(url);
  if (data?.[1]) return data[1];
  return "application/octet-stream";
}
