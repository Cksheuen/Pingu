// SSE pipeline for upstream streaming responses.
// The upstream speaks standard Server-Sent Events ("data: <json>\n\n"); TCP
// chunks can split a line across reads, so lines are only split on \n
// boundaries. The translated stream is a pipeThrough chain, so downstream
// backpressure (a slow client) propagates to the upstream reader, and client
// disconnect cancels the upstream fetch.

const encoder = new TextEncoder();

// Transform raw bytes into the trimmed payload of each "data:" line.
// Heartbeats, comments and event/field lines are dropped.
export function createSseLineTransformer(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();
  let buffer = "";
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload !== "") controller.enqueue(payload);
      }
    },
    flush(controller) {
      const tail = buffer.trim();
      if (tail.startsWith("data:")) {
        const payload = tail.slice(5).trim();
        if (payload !== "") controller.enqueue(payload);
      }
    }
  });
}

// Drive a response translator over an upstream SSE stream.
// feed:  one upstream data payload -> zero or more client SSE event strings
// finish: called once when the upstream stream ends -> trailing event strings
export function translateUpstreamSse(
  upstream: ReadableStream<Uint8Array>,
  feed: (data: string) => string[],
  finish: () => string[]
): ReadableStream<Uint8Array> {
  return upstream
    .pipeThrough(createSseLineTransformer())
    .pipeThrough(
      new TransformStream<string, Uint8Array>({
        transform(data, controller) {
          try {
            for (const event of feed(data)) controller.enqueue(encoder.encode(event));
          } catch (error) {
            // A malformed upstream frame must terminate this request cleanly;
            // never let an unhandled stream error crash the gateway process.
            const message = error instanceof Error ? error.message : "invalid upstream event";
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "upstream_error", message } })}\n\n`));
            controller.terminate();
          }
        },
        flush(controller) {
          for (const event of finish()) {
            controller.enqueue(encoder.encode(event));
          }
        }
      })
    );
}

// CPA's Gemini carrier can append an empty thinking/signature block after the
// text block. Anthropic clients expect thinking to precede text; suppress only
// those trailing blocks while preserving normal streaming and all other events.
export function normalizeAnthropicSse(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sawText = false;
  const suppressed = new Set<number>();

  const processBlock = (block: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) {
      controller.enqueue(encoder.encode(`${block}\n\n`));
      return;
    }

    let payload: { type?: string; index?: number; content_block?: { type?: string } };
    try {
      payload = JSON.parse(dataLine.slice(5).trim()) as typeof payload;
    } catch {
      controller.enqueue(encoder.encode(`${block}\n\n`));
      return;
    }

    const index = typeof payload.index === "number" ? payload.index : -1;
    if (payload.type === "content_block_start" && payload.content_block?.type === "text") {
      sawText = true;
    }
    if (payload.type === "content_block_start" && payload.content_block?.type === "thinking" && sawText) {
      if (index >= 0) suppressed.add(index);
      return;
    }
    if (payload.type === "content_block_delta" && index >= 0 && suppressed.has(index)) return;
    if (payload.type === "content_block_stop" && index >= 0 && suppressed.has(index)) {
      suppressed.delete(index);
      return;
    }
    controller.enqueue(encoder.encode(`${block}\n\n`));
  };

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let separator: number;
        while ((separator = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/, "");
          processBlock(block, controller);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim() !== "") processBlock(buffer, controller);
      }
    })
  );
}

export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive"
};
