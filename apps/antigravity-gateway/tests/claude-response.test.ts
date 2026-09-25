import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeSseTranslator, claudeNonStream } from "../src/translate/claudeResponse";
import type { AnthropicRequestBody } from "../src/translate/types";

function parseEvents(events: string[]): Array<{ event: string; data: Record<string, unknown> }> {
  return events.map((raw) => {
    const match = raw.match(/^event: (.*)\ndata: (.*)\n\n$/s);
    assert.ok(match, `event should match SSE shape: ${raw}`);
    return { event: match[1], data: JSON.parse(match[2]) as Record<string, unknown> };
  });
}

function feedAll(translator: ClaudeSseTranslator, chunks: string[]): Array<{ event: string; data: Record<string, unknown> }> {
  const events: string[] = [];
  for (const chunk of chunks) events.push(...translator.feed(chunk));
  events.push(...translator.finish());
  return parseEvents(events);
}

test("pure text stream emits the full event sequence", () => {
  const translator = new ClaudeSseTranslator();
  const events = feedAll(translator, [
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0, totalTokenCount: 15 },
      modelVersion: "gemini-2.5-pro",
      responseId: "resp-1"
    })
  ]);

  assert.deepEqual(
    events.map((event) => event.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]
  );
  assert.equal((events[0].data.message as { model: string }).model, "gemini-2.5-pro");
  assert.equal((events[0].data.message as { id: string }).id, "resp-1");
  assert.equal((events[1].data.content_block as { type: string }).type, "text");
  assert.equal((events[2].data.delta as { text: string }).text, "Hello");
  const messageDelta = events[4].data as unknown as { delta: { stop_reason: string }; usage: { input_tokens: number; output_tokens: number } };
  assert.equal(messageDelta.delta.stop_reason, "end_turn");
  assert.equal(messageDelta.usage.input_tokens, 10);
  assert.equal(messageDelta.usage.output_tokens, 5);
});

test("thinking then text switches blocks with open/close", () => {
  const translator = new ClaudeSseTranslator();
  const events = feedAll(translator, [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }] } }] }),
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 4 }
    })
  ]);

  const sequence = events.map((event) => event.event);
  assert.deepEqual(sequence, [
    "message_start",
    "content_block_start", // thinking
    "content_block_delta", // thinking_delta
    "content_block_stop",
    "content_block_start", // text
    "content_block_delta", // text_delta
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  assert.equal((events[1].data.content_block as { type: string }).type, "thinking");
  assert.equal((events[2].data.delta as { thinking: string }).thinking, "hmm");
  assert.equal((events[4].data.content_block as { type: string }).type, "text");
  assert.equal((events[5].data.delta as { text: string }).text, "answer");
  // output_tokens = candidatesTokenCount + thoughtsTokenCount
  assert.equal((events[7].data.usage as { output_tokens: number }).output_tokens, 3);
});

test("thought part with signature emits signature_delta", () => {
  const translator = new ClaudeSseTranslator();
  const events = feedAll(translator, [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "hmm", thought: true, thoughtSignature: "sig-1" }] } }] }),
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    })
  ]);
  const signatureDeltas = events.filter((event) => (event.data.delta as { type?: string })?.type === "signature_delta");
  assert.equal(signatureDeltas.length, 1);
  assert.equal((signatureDeltas[0].data.delta as { signature: string }).signature, "sig-1");
});

test("signature-only part does not open an empty text block", () => {
  const translator = new ClaudeSseTranslator();
  const events = feedAll(translator, [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }] }),
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "", thoughtSignature: "sig-test" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 2, totalTokenCount: 12 }
    })
  ]);
  const textBlockStarts = events.filter(
    (event) => event.event === "content_block_start" && (event.data.content_block as { type: string }).type === "text"
  );
  assert.equal(textBlockStarts.length, 0);
  const signatureDeltas = events.filter((event) => (event.data.delta as { type?: string })?.type === "signature_delta");
  assert.equal(signatureDeltas.length, 1);
  assert.equal((signatureDeltas[0].data.delta as { signature: string }).signature, "sig-test");
});

test("tool call in a single chunk", () => {
  const request: AnthropicRequestBody = {
    model: "gemini-2.5-pro",
    messages: [],
    tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: {} } }]
  };
  const translator = new ClaudeSseTranslator(request);
  const events = feedAll(translator, [
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }] },
          finishReason: "STOP"
        }
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 }
    })
  ]);

  const toolStart = events.find(
    (event) => event.event === "content_block_start" && (event.data.content_block as { type: string }).type === "tool_use"
  );
  assert.ok(toolStart);
  const block = toolStart.data.content_block as { id: string; name: string; input: unknown };
  assert.equal(block.name, "get_weather");
  assert.deepEqual(block.input, {});
  assert.match(block.id, /^get_weather-\d+$/);
  const inputDelta = events.find(
    (event) => (event.data.delta as { type?: string })?.type === "input_json_delta"
  );
  assert.ok(inputDelta);
  assert.equal((inputDelta.data.delta as { partial_json: string }).partial_json, JSON.stringify({ city: "SF" }));
  const messageDelta = events.find((event) => event.event === "message_delta");
  assert.equal((messageDelta?.data.delta as { stop_reason: string }).stop_reason, "tool_use");
});

test("tool call split across chunks continues with empty name", () => {
  const translator = new ClaudeSseTranslator();
  const events = feedAll(translator, [
    JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "/" } } }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "", args: { page: 2 } } }] } }] }),
    JSON.stringify({
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 }
    })
  ]);

  const toolStarts = events.filter(
    (event) => event.event === "content_block_start" && (event.data.content_block as { type: string }).type === "tool_use"
  );
  assert.equal(toolStarts.length, 1);
  const inputDeltas = events.filter((event) => (event.data.delta as { type?: string })?.type === "input_json_delta");
  assert.equal(inputDeltas.length, 2);
  assert.equal((inputDeltas[0].data.delta as { partial_json: string }).partial_json, JSON.stringify({ path: "/" }));
  assert.equal((inputDeltas[1].data.delta as { partial_json: string }).partial_json, JSON.stringify({ page: 2 }));
});

test("MAX_TOKENS finish reason maps to max_tokens", () => {
  const translator = new ClaudeSseTranslator();
  const events = feedAll(translator, [
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
    })
  ]);
  const messageDelta = events.find((event) => event.event === "message_delta");
  assert.equal((messageDelta?.data.delta as { stop_reason: string }).stop_reason, "max_tokens");
});

test("no content produces no events and no message_stop", () => {
  const translator = new ClaudeSseTranslator();
  const events = translator.feed(
    JSON.stringify({
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0, totalTokenCount: 1 }
    })
  );
  assert.deepEqual(events, []);
  assert.deepEqual(translator.finish(), []);
});

test("non-stream aggregation builds a full message", () => {
  const message = claudeNonStream(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: "hmm", thought: true },
              { text: "Hello " },
              { text: "world" },
              { functionCall: { name: "get_weather", args: { city: "SF" } } }
            ]
          },
          finishReason: "STOP"
        }
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6, thoughtsTokenCount: 2, totalTokenCount: 18 },
      modelVersion: "gemini-2.5-pro",
      responseId: "resp-9"
    }),
    "fallback-model"
  );

  assert.equal(message.id, "resp-9");
  assert.equal(message.model, "gemini-2.5-pro");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 8 });
  assert.equal(message.content.length, 3);
  assert.deepEqual(message.content[0], { type: "thinking", thinking: "hmm" });
  assert.deepEqual(message.content[1], { type: "text", text: "Hello world" });
  const toolBlock = message.content[2] as { type: string; id: string; name: string; input: unknown };
  assert.equal(toolBlock.type, "tool_use");
  assert.equal(toolBlock.name, "get_weather");
  assert.deepEqual(toolBlock.input, { city: "SF" });
});

test("non-stream without usageMetadata omits usage", () => {
  const message = claudeNonStream(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] }),
    "fallback-model"
  );
  assert.equal(message.usage, undefined);
  assert.equal(message.model, "fallback-model");
  assert.equal(message.stop_reason, "end_turn");
});
