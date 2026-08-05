import { describe, expect, test } from "bun:test";
import { displayAddress, parseHttpUrl } from "./net.ts";

describe("displayAddress", () => {
  test("maps wildcard binds to a loopback address", () => {
    expect(displayAddress("0.0.0.0")).toBe("127.0.0.1");
    expect(displayAddress("::")).toBe("127.0.0.1");
    expect(displayAddress("::0")).toBe("127.0.0.1");
    expect(displayAddress("0:0:0:0:0:0:0:0")).toBe("127.0.0.1");
  });

  test("keeps concrete addresses unchanged", () => {
    expect(displayAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(displayAddress("localhost")).toBe("localhost");
    expect(displayAddress("::1")).toBe("::1");
  });
});

describe("parseHttpUrl", () => {
  test("parses a valid http(s) url", () => {
    expect(parseHttpUrl("http://localhost:4096")?.protocol).toBe("http:");
    expect(parseHttpUrl("https://opencode.example")?.protocol).toBe("https:");
  });

  test("returns undefined for malformed urls", () => {
    expect(parseHttpUrl("not a url")).toBeUndefined();
  });

  test("returns undefined for non-http schemes", () => {
    expect(parseHttpUrl("ftp://example.com")).toBeUndefined();
  });
});
