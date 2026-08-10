import { describe, expect, test } from "bun:test";
import { parseBoolean } from "./parse.ts";

describe("parseBoolean", () => {
  test("reads true and false", () => {
    expect(parseBoolean("true")).toBe(true);
    expect(parseBoolean("false")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(parseBoolean("TRUE")).toBe(true);
    expect(parseBoolean("True")).toBe(true);
    expect(parseBoolean("FALSE")).toBe(false);
    expect(parseBoolean("False")).toBe(false);
  });

  test("trims surrounding whitespace", () => {
    expect(parseBoolean("  true  ")).toBe(true);
    expect(parseBoolean(" false ")).toBe(false);
  });

  test("returns undefined for non-boolean values", () => {
    for (const value of ["", " ", "1", "0", "yes", "no", "on", "y", "n", " random "]) {
      expect(parseBoolean(value)).toBeUndefined();
    }
  });
});
