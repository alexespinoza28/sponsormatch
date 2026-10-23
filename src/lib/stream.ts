// Newline-delimited JSON streaming for the agent routes, so the UI can render
// each trace event as it happens.

export function ndjsonResponse<E>(run: (emit: (event: E) => void) => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: E) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await run(emit);
      } catch {
        // The runner already emitted an error event.
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
