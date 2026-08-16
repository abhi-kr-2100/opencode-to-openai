import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantInfo, completionRequest, fakeClient, StreamMode } from "./opencode.ts";

async function withTmpDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withScratchAgent(dir: string): Promise<void> {
  const agentsDir = join(dir, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "scratch.md"), ".\n");
}

describe("fakeClient", () => {
  test("throws when creating a session without a directory", async () => {
    const client = fakeClient();
    expect(client.session.create()).rejects.toThrow(/expected a directory/);
  });

  test("throws when creating a session with a non-existent directory", async () => {
    const client = fakeClient();
    expect(client.session.create({ query: { directory: "/no/such/dir" } })).rejects.toThrow(
      /expected a directory/,
    );
  });

  test("creates a session in an existing directory", async () => {
    await withTmpDir(async (dir) => {
      await withScratchAgent(dir);
      const client = fakeClient({ create: { data: { id: "session-9" } } });
      const result = client.session.create({ query: { directory: dir } });
      expect(result).resolves.toMatchObject({ data: { id: "session-9" } });
    });
  });

  test("rethrows the create error override", async () => {
    const client = fakeClient({ create: { error: new TypeError("fetch failed") } });
    await withTmpDir(async (dir) => {
      await withScratchAgent(dir);
      expect(client.session.create({ query: { directory: dir } })).rejects.toThrow("fetch failed");
    });
  });

  test("throws when prompting without an override", async () => {
    const client = fakeClient({ create: { data: { id: "session-1" } } });
    expect(
      client.session.prompt({
        path: { id: "session-1" },
        body: { parts: [{ type: "text", text: "hi" }] },
      }),
    ).rejects.toThrow(/overrides.prompt is required/);
    expect(client.calls).toHaveLength(1);
  });

  test("prompt resolves data and records the call", async () => {
    const info = assistantInfo();
    const client = fakeClient({
      prompt: { data: { info, parts: [] } },
    });
    const body = { parts: [{ type: "text" as const, text: "hi" }] };
    expect(client.session.prompt({ path: { id: "session-1" }, body })).resolves.toMatchObject({
      data: { info, parts: [] },
    });
    expect(client.calls).toEqual([{ method: "prompt", body }]);
  });

  test("prompt rethrows the error override", async () => {
    const client = fakeClient({ prompt: { error: new TypeError("prompt failed") } });
    expect(
      client.session.prompt({
        path: { id: "session-1" },
        body: { parts: [{ type: "text", text: "hi" }] },
      }),
    ).rejects.toThrow("prompt failed");
  });

  test("delete marks deleted and resolves data", async () => {
    const client = fakeClient();
    expect(client.deleted).toBe(false);
    expect(client.session.delete({ path: { id: "session-1" } })).resolves.toMatchObject({
      data: true,
    });
    expect(client.deleted).toBe(true);
  });

  test("delete rethrows the error override", async () => {
    const client = fakeClient({ delete: { error: new TypeError("delete failed") } });
    expect(client.session.delete({ path: { id: "session-1" } })).rejects.toThrow("delete failed");
    expect(client.deleted).toBe(true);
  });
});

describe("assistantInfo", () => {
  test("returns sane defaults", () => {
    expect(assistantInfo()).toEqual({
      id: "message-1",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 0, completed: 1 },
      parentID: "user-1",
      modelID: "claude-3-5-sonnet-20241022",
      providerID: "anthropic",
      mode: "primary",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    });
  });

  test("merges overrides", () => {
    expect(assistantInfo({ id: "other" }).id).toBe("other");
  });
});

describe("completionRequest", () => {
  test("streams when asked to", () => {
    expect(completionRequest(StreamMode.Streaming).stream).toBe(true);
  });

  test("does not stream otherwise", () => {
    expect(completionRequest(StreamMode.NonStreaming).stream).toBe(false);
  });
});
