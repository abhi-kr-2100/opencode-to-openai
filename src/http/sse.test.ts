import { describe, expect, test } from "bun:test";
import { encodeSseEvent, sseResponse } from "./sse.ts";

async function streamToText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function* framedEvents(): AsyncGenerator<unknown> {
  yield { type: "text", content: "hi" };
  yield "plain";
}

async function* failingEvents(): AsyncGenerator<unknown> {
  yield "a";
  throw new Error("boom");
}

/**
 * A re-iterable source whose iterator is idle awaiting a backend read until its
 * `return()` is called, so that only canceling the iterator actually being
 * consumed can release it. Each call to `[Symbol.asyncIterator]()` yields a
 * fresh iterator with its own id; `begunIds()` reports which iterators the
 * consumer started reading and `releasedIds()` which ones were canceled.
 */
function pendingSource(): {
  source: AsyncIterable<unknown>;
  begunIds: () => number[];
  releasedIds: () => number[];
} {
  let nextId = 0;
  const begun: number[] = [];
  const released: number[] = [];
  return {
    source: {
      [Symbol.asyncIterator]() {
        const id = nextId++;
        let release: () => void = () => {};
        const closed = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            begun.push(id);
            await closed;
            return { done: true, value: undefined };
          },
          async return() {
            if (!released.includes(id)) {
              released.push(id);
            }
            release();
            return { done: true, value: undefined };
          },
        };
      },
    },
    begunIds: () => [...begun],
    releasedIds: () => [...released],
  };
}

function infiniteEvents(): { events: AsyncIterable<unknown>; returned: () => boolean } {
  let returned = false;
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) yield "x";
        } finally {
          returned = true;
        }
      },
    },
    returned: () => returned,
  };
}

describe("encodeSseEvent", () => {
  test("passes single-line strings through raw", () => {
    expect(encodeSseEvent("hello")).toBe("data: hello\n\n");
  });

  test("prefixes each payload line with data so multiline strings survive SSE framing", () => {
    expect(encodeSseEvent("hello\nworld")).toBe("data: hello\ndata: world\n\n");
    expect(encodeSseEvent("a\nb\nc")).toBe("data: a\ndata: b\ndata: c\n\n");
  });

  test("does not let blank lines terminate the event early", () => {
    expect(encodeSseEvent("line1\n\nline2")).toBe(
      "data: line1\ndata: \ndata: line2\n\n",
    );
  });

  test("stringifies non-strings as JSON", () => {
    expect(encodeSseEvent({ a: 1 })).toBe('data: {"a":1}\n\n');
  });
});

describe("sseResponse", () => {
  test("frames an async iterable as an SSE response", async () => {
    const response = sseResponse(framedEvents());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(await streamToText(response)).toBe(
      'data: {"type":"text","content":"hi"}\n\ndata: plain\n\n',
    );
  });

  test("propagates errors from the iterable to the stream", async () => {
    const response = sseResponse(failingEvents());
    await expect(streamToText(response)).rejects.toThrow("boom");
  });

  test("releases the iterator being consumed when the consumer cancels", async () => {
    const { source, begunIds, releasedIds } = pendingSource();
    const response = sseResponse(source);
    for (let i = 0; i < 100 && begunIds().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(begunIds()).toHaveLength(1);
    const consumedId = begunIds()[0]!;
    await response.body!.getReader().cancel();
    for (let i = 0; i < 100 && releasedIds().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(releasedIds()).toContain(consumedId);
  });

  test("closes the iterator when the consumer cancels", async () => {
    const { events, returned } = infiniteEvents();
    const response = sseResponse(events);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    for (let i = 0; i < 5; i++) {
      if (returned()) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(returned()).toBe(true);
  });
});
