export const SSE_DONE = "[DONE]";

export function encodeSseEvent(data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `data: ${payload.replace(/\n/g, "\ndata: ")}\n\n`;
}

export function sseResponse<T>(events: AsyncIterable<T>): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let cancelled = false;
  let returned = false;
  const returnOnce = (): Promise<IteratorResult<T>> => {
    if (returned) {
      return Promise.resolve({ done: true, value: undefined as T });
    }
    returned = true;
    return iterator.return ? iterator.return() : Promise.resolve({ done: true, value: undefined as T });
  };
  const guardedIterator = {
    next: () => iterator.next(),
    return: returnOnce,
  };
  const iterableWrapper: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return guardedIterator;
    },
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Using for await...of avoids the eslint(no-await-in-loop) warning,
        // while the guarded iterator funnels both cancellation and
        // AsyncIteratorClose through the same once-only return.
        for await (const value of iterableWrapper) {
          if (cancelled) return;
          controller.enqueue(encoder.encode(encodeSseEvent(value)));
        }
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      void returnOnce();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
