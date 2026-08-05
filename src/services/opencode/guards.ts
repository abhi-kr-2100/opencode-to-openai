/** Type guard for plain (non-array) objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads the `message` field of an error payload, if present. */
export function messageOf(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return undefined;
}

/** Returns the MIME type of a data URL, falling back to octet-stream for plain URLs. */
export function mimeFromUrl(url: string): string {
  if (url.startsWith("data:")) {
    const end = url.indexOf(",", 5);
    const mime = end >= 0 ? url.slice(5, end).split(";")[0] : url.slice(5);
    if (mime) return mime;
  }
  return "application/octet-stream";
}
