import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAnthropicSse } from "../src/upstream/sse";

async function normalize(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
  return new Response(normalizeAnthropicSse(upstream)).text();
}

test("normalizes CPA trailing thinking block after text", async () => {
  const output = await normalize([
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"secret"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
    'event: message_stop\ndata: {"type":"message_stop"}'
  ].join("\n\n") + "\n\n");

  assert.match(output, /text_delta/);
  assert.match(output, /hello/);
  assert.match(output, /message_stop/);
  assert.doesNotMatch(output, /signature_delta/);
  assert.doesNotMatch(output, /secret/);
});

test("preserves thinking block that precedes text", async () => {
  const output = await normalize([
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}'
  ].join("\n\n") + "\n\n");

  assert.match(output, /thinking_delta/);
  assert.match(output, /reason/);
  assert.match(output, /content_block_start/);
});
