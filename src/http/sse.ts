export const SSE_DONE = "[DONE]";

export function encodeSseEvent(data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `data: ${payload.replace(/\n/g, "\ndata: ")}\n\n`;
}

export function sseResponse(events: AsyncIterable<unknown>): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          if (cancelled) return;
          const { done, value } = await iterator.next();
          if (done) break;
          controller.enqueue(encoder.encode(encodeSseEvent(value)));
        }
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      if (iterator.return) {
        void iterator.return();
      }
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
