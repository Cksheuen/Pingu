import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiSseTranslator, openAiNonStream } from "../src/translate/openaiResponse";

function parseChunks(strings: string[]): Record<string, unknown>[] {
  return strings.map((raw) => {
    assert.ok(raw.startsWith("data: "), `chunk should start with "data: ": ${raw}`);
    assert.ok(raw.endsWith("\n\n"), `chunk should end with blank line: ${raw}`);
    const payload = raw.slice(6, -2);
    assert.notEqual(payload, "[DONE]", "parseChunks received the sentinel; use feedAll");
    return JSON.parse(payload) as Record<string, unknown>;
  });
}

function feedAll(translator: OpenAiSseTranslator, chunks: string[]): Array<Record<string, unknown> | "[DONE]"> {
  const out: string[] = [];
  for (const chunk of chunks) out.push(...translator.feed(chunk));
  const parsed = parseChunks(out) as Array<Record<string, unknown> | "[DONE]">;
  for (const _ of translator.finish()) parsed.push("[DONE]");
  return parsed;
}

function asObject(chunk: Record<string, unknown> | "[DONE]"): Record<string, unknown> {
  assert.notEqual(chunk, "[DONE]");
  return chunk as Record<string, unknown>;
}

test("text delta streams content with assistant role", () => {
  const translator = new OpenAiSseTranslator();
  const chunks = parseChunks(
    translator.feed(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] }))
  );
  assert.equal(chunks.length, 1);
  const choice = (chunks[0].choices as Array<{ delta: { role: string; content: string } }>)[0];
  assert.equal(choice.delta.role, "assistant");
  assert.equal(choice.delta.content, "Hello");
  assert.equal(chunks[0].id, "");
});

test("thought part streams reasoning_content", () => {
  const translator = new OpenAiSseTranslator();
  const chunks = parseChunks(
    translator.feed(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }] } }] })
    )
  );
  const choice = (chunks[0].choices as Array<{ delta: { reasoning_content: string; content: null } }>)[0];
  assert.equal(choice.delta.reasoning_content, "hmm");
  assert.equal(choice.delta.content, null);
});

test("function call streams tool_calls delta", () => {
  const translator = new OpenAiSseTranslator();
  const chunks = parseChunks(
    translator.feed(
      JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: "list_dir", args: { path: "/" } } }] } }]
      })
    )
  );
  const choice = (chunks[0].choices as Array<{ delta: { tool_calls: Array<Record<string, unknown>> } }>)[0];
  assert.equal(choice.delta.tool_calls.length, 1);
  const toolCall = choice.delta.tool_calls[0];
  assert.equal(toolCall.type, "function");
  assert.equal((toolCall.function as { name: string }).name, "list_dir");
  assert.equal((toolCall.function as { arguments: string }).arguments, '{"path":"/"}');
  assert.match(toolCall.id as string, /^list_dir-\d+-\d+$/);
});

test("usage chunk carries token counts and cached tokens", () => {
  const translator = new OpenAiSseTranslator();
  const chunks = parseChunks(
    translator.feed(
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 16,
          candidatesTokenCount: 42,
          thoughtsTokenCount: 4,
          totalTokenCount: 58,
          cachedContentTokenCount: 7
        }
      })
    )
  );
  assert.equal(chunks.length, 1);
  const usage = chunks[0].usage as {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details: { reasoning_tokens: number };
    prompt_tokens_details: { cached_tokens: number };
  };
  assert.equal(usage.prompt_tokens, 16);
  assert.equal(usage.completion_tokens, 42);
  assert.equal(usage.total_tokens, 58);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 4);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 7);
});

test("finish_reason only on the final chunk", () => {
  const translator = new OpenAiSseTranslator();
  const chunks = feedAll(translator, [
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "list_dir", args: { path: "C:/" } } }] } }],
      usageMetadata: { trafficType: "ON_DEMAND" }
    }),
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "list_dir", args: { path: "D:/" } } }] } }],
      usageMetadata: { trafficType: "ON_DEMAND" }
    }),
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    })
  ]);
  // Last element is the [DONE] sentinel.
  assert.equal(chunks[chunks.length - 1], "[DONE]");
  const first = asObject(chunks[0]).choices as Array<{ finish_reason: string | null }>;
  assert.equal(first[0].finish_reason, null);
  const final = asObject(chunks[chunks.length - 2]).choices as Array<{ finish_reason: string; native_finish_reason: string }>;
  assert.equal(final[0].finish_reason, "tool_calls");
  assert.equal(final[0].native_finish_reason, "stop");
});

test("MAX_TOKENS maps to max_tokens", () => {
  const translator = new OpenAiSseTranslator();
  const chunks = feedAll(translator, [
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
    })
  ]);
  const final = asObject(chunks[0]).choices as Array<{ finish_reason: string }>;
  assert.equal(final[0].finish_reason, "max_tokens");
});

test("SAFETY maps to content_filter", () => {
  const translator = new OpenAiSseTranslator();
  const chunks = feedAll(translator, [
    JSON.stringify({
      candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 }
    })
  ]);
  const final = asObject(chunks[0]).choices as Array<{ finish_reason: string }>;
  assert.equal(final[0].finish_reason, "content_filter");
});

test("finish() emits the [DONE] sentinel", () => {
  const translator = new OpenAiSseTranslator();
  assert.deepEqual(translator.finish(), ["data: [DONE]\n\n"]);
});

test("non-stream aggregation builds a full completion", () => {
  const completion = openAiNonStream(
    JSON.stringify({
      candidates: [
        {
          index: 0,
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
      responseId: "resp-1"
    }),
    "fallback-model"
  );

  assert.equal(completion.id, "resp-1");
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "gemini-2.5-pro");
  assert.equal(completion.choices.length, 1);
  const choice = completion.choices[0];
  assert.equal(choice.message.role, "assistant");
  assert.equal(choice.message.content, "Hello world");
  assert.equal(choice.message.reasoning_content, "hmm");
  assert.equal(choice.message.tool_calls?.length, 1);
  assert.equal((choice.message.tool_calls?.[0].function as { name: string }).name, "get_weather");
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(completion.usage?.prompt_tokens, 10);
  assert.equal(completion.usage?.completion_tokens, 6);
  assert.equal(completion.usage?.completion_tokens_details?.reasoning_tokens, 2);
});

test("non-stream single text part keeps content as a string", () => {
  const completion = openAiNonStream(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] }),
    "fallback-model"
  );
  assert.equal(completion.choices[0].message.content, "hi");
  assert.equal(completion.choices[0].finish_reason, "stop");
  assert.equal(completion.model, "fallback-model");
});

test("non-stream empty text parts produce empty strings", () => {
  const completion = openAiNonStream(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "" }, { text: "", thought: true }] }, finishReason: "STOP" }]
    }),
    "fallback-model"
  );
  const message = completion.choices[0].message;
  assert.equal(message.content, "");
  assert.equal(message.reasoning_content, "");
});
