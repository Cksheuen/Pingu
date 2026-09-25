import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiChatToGemini } from "../src/translate/openaiRequest";
import { defaultSafetySettings } from "../src/translate/common";
import type { GeminiRequestBody, OpenAiRequestBody } from "../src/translate/types";

function convert(body: OpenAiRequestBody): GeminiRequestBody {
  return openaiChatToGemini(body);
}

test("system and developer messages merge into systemInstruction", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "system", content: "Be concise" },
      { role: "developer", content: "Follow the rules" },
      { role: "user", content: "hi" }
    ]
  });
  assert.equal(out.systemInstruction?.role, "user");
  assert.deepEqual(
    out.systemInstruction?.parts.map((part) => part.text),
    ["Be concise", "Follow the rules"]
  );
  // The user message is the only content turn.
  assert.equal(out.contents.length, 1);
  assert.equal(out.contents[0].role, "user");
});

test("a lone system message becomes the user turn", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "system", content: "Only system" }]
  });
  assert.equal(out.systemInstruction, undefined);
  assert.equal(out.contents.length, 1);
  assert.equal(out.contents[0].parts[0].text, "Only system");
});

test("assistant tool_calls plus tool messages merge into model + user turns", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "sure",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: '{"output":"ok"}' },
      { role: "user", content: "say ok" }
    ]
  });
  assert.equal(out.contents.length, 4);
  assert.equal(out.contents[1].role, "model");
  assert.deepEqual(out.contents[1].parts[0], { text: "sure" });
  assert.deepEqual(out.contents[1].parts[1], {
    functionCall: { name: "read_file", args: { path: "/a" } },
    thoughtSignature: "skip_thought_signature_validator"
  });
  assert.equal(out.contents[2].role, "user");
  const functionResponse = out.contents[2].parts[0].functionResponse;
  assert.ok(functionResponse);
  assert.equal(functionResponse?.name, "read_file");
  // Go writes the raw content as a JSON string value (double-encoded).
  assert.equal(functionResponse?.response.result, '"{\\"output\\":\\"ok\\"}"');
});

test("reasoning_content becomes a thought part with bypass signature", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "visible", reasoning_content: "thinking only" }
    ]
  });
  // Trailing model turn is dropped, so assert on the pre-strip state via a
  // non-trailing assistant turn instead.
  const kept = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "visible", reasoning_content: "thinking only" },
      { role: "user", content: "again" }
    ]
  });
  assert.equal(kept.contents[1].parts[0].text, "thinking only");
  assert.equal(kept.contents[1].parts[0].thought, true);
  assert.equal(kept.contents[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(kept.contents[1].parts[1].text, "visible");
  assert.equal(out.contents.length, 1);
});

test("tools parameters renamed to parametersJsonSchema and cleaned", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "search_company",
          description: "Search",
          parameters: {
            type: "object",
            title: "SearchCompany",
            properties: {
              country: { type: "string" },
              industry: { type: "string" }
            },
            required: ["country", "industry", "stale_field"]
          }
        }
      }
    ]
  });
  const declaration = out.tools?.[0].functionDeclarations?.[0] as unknown as {
    name: string;
    parametersJsonSchema: Record<string, unknown>;
  };
  assert.equal(declaration.name, "search_company");
  assert.equal(declaration.parametersJsonSchema.title, undefined);
  assert.deepEqual(declaration.parametersJsonSchema.required, ["country", "industry"]);
});

test("tools without parameters get an empty object schema", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "ping", description: "ping" } }]
  });
  const declaration = out.tools?.[0].functionDeclarations?.[0] as unknown as {
    parametersJsonSchema: unknown;
  };
  assert.deepEqual(declaration.parametersJsonSchema, { type: "object", properties: {} });
});

test("google_search and code_execution tools pass through", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f" } }, { google_search: {} }, { code_execution: {} }]
  });
  assert.equal(out.tools?.length, 3);
  assert.deepEqual(out.tools?.[1], { googleSearch: {} });
  assert.deepEqual(out.tools?.[2], { codeExecution: {} });
});

test("response_format json_object -> responseMimeType", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "json" }],
    response_format: { type: "json_object" }
  });
  assert.equal(out.generationConfig?.responseMimeType, "application/json");
});

test("response_format json_schema -> responseMimeType + responseJsonSchema passthrough", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "json" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: {
          type: "object",
          properties: { cleanedContent: { type: "string" } },
          required: ["cleanedContent"],
          additionalProperties: false
        }
      }
    }
  });
  assert.equal(out.generationConfig?.responseMimeType, "application/json");
  assert.deepEqual(out.generationConfig?.responseJsonSchema, {
    type: "object",
    properties: { cleanedContent: { type: "string" } },
    required: ["cleanedContent"],
    additionalProperties: false
  });
  assert.equal((out.generationConfig as { responseSchema?: unknown })?.responseSchema, undefined);
});

test("reasoning_effort maps to thinkingLevel, auto to budget -1", () => {
  const low = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "HIGH"
  });
  assert.equal(low.generationConfig?.thinkingConfig?.thinkingLevel, "high");
  const auto = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "auto"
  });
  assert.equal(auto.generationConfig?.thinkingConfig?.thinkingBudget, -1);
});

test("max_tokens and max_completion_tokens map to maxOutputTokens", () => {
  const withMaxTokens = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 30
  });
  assert.equal(withMaxTokens.generationConfig?.maxOutputTokens, 30);
  const withCompletionTokens = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 40
  });
  assert.equal(withCompletionTokens.generationConfig?.maxOutputTokens, 40);
  const both = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 30,
    max_completion_tokens: 40
  });
  assert.equal(both.generationConfig?.maxOutputTokens, 30);
});

test("trailing assistant message is dropped", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  });
  assert.equal(out.contents.length, 1);
  assert.equal(out.contents[0].role, "user");
});

test("image_url data URI becomes inlineData", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }
        ]
      }
    ]
  });
  assert.deepEqual(out.contents[0].parts[1], {
    inlineData: { mime_type: "image/png", data: "aGVsbG8=" },
    thoughtSignature: "skip_thought_signature_validator"
  });
});

test("default safety settings are attached", () => {
  const out = convert({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(out.safetySettings, defaultSafetySettings());
});
