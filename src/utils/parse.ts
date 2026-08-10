export function parseBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return undefined;
  }
}
