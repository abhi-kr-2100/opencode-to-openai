import { describe, expect, test } from "bun:test";
import { isRecord, messageOf, mimeFromUrl } from "./guards.ts";

describe("isRecord", () => {
  test("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1, nested: { b: 2 } })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  test("rejects primitives and null", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(Symbol("s"))).toBe(false);
    expect(isRecord(123n)).toBe(false);
  });

  test("rejects arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  test("rejects built-in objects that are not plain records", () => {
    expect(isRecord(new Date())).toBe(false);
    expect(isRecord(/regex/)).toBe(false);
    expect(isRecord(new Map())).toBe(false);
    expect(isRecord(new Set())).toBe(false);
    expect(isRecord(new Promise(() => {}))).toBe(false);
    expect(isRecord(new Error("boom"))).toBe(false);
    expect(isRecord(new URL("https://example.com"))).toBe(false);
  });

  test("rejects class instances", () => {
    class Foo {
      readonly value = 42;
    }
    expect(isRecord(new Foo())).toBe(false);
  });
});

describe("messageOf", () => {
  test("reads string message from plain objects", () => {
    expect(messageOf({ message: "hello" })).toBe("hello");
  });

  test("returns undefined when message is not a string", () => {
    expect(messageOf({ message: 42 })).toBeUndefined();
    expect(messageOf({})).toBeUndefined();
  });

  test("is undefined for Date objects even with a message-like shape", () => {
    expect(messageOf(new Date("garbage"))).toBeUndefined();
  });
});

describe("mimeFromUrl", () => {
  test("extracts the MIME type from data URLs", () => {
    expect(mimeFromUrl("data:image/png;base64,AAAA")).toBe("image/png");
    expect(mimeFromUrl("data:text/plain,hello")).toBe("text/plain");
  });

  test("falls back to octet-stream for plain URLs", () => {
    expect(mimeFromUrl("https://example.com/file.png")).toBe("application/octet-stream");
    expect(mimeFromUrl("not a url")).toBe("application/octet-stream");
  });
});
