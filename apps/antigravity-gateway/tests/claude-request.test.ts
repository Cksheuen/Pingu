import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeMessagesToGemini } from "../src/translate/claudeRequest";
import { defaultSafetySettings } from "../src/translate/common";
import type { AnthropicRequestBody, GeminiRequestBody } from "../src/translate/types";

function convert(body: AnthropicRequestBody): GeminiRequestBody {
  return claudeMessagesToGemini(body);
}

test("system string -> systemInstruction without role", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    system: "Be concise",
    messages: [{ role: "user", content: "Hello" }]
  });
  assert.equal(out.systemInstruction?.role, undefined);
  assert.deepEqual(out.systemInstruction, { parts: [{ text: "Be concise" }] });
});

test("system array -> systemInstruction with role user, attribution stripped", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.63;" },
      { type: "text", text: "You are a helpful agent." },
      { type: "text", text: "User system prompt" }
    ],
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(out.systemInstruction?.role, "user");
  assert.deepEqual(
    out.systemInstruction?.parts.map((part) => part.text),
    ["You are a helpful agent.", "User system prompt"]
  );
});

test("multi-turn text + tool_use + tool_result", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "get_weather-call_1", name: "get_weather", input: { city: "SF" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "get_weather-call_1", content: "sunny" }]
      }
    ]
  });
  assert.equal(out.contents.length, 3);
  assert.equal(out.contents[0].role, "user");
  assert.equal(out.contents[1].role, "model");
  assert.deepEqual(out.contents[1].parts[0], {
    thoughtSignature: "skip_thought_signature_validator",
    functionCall: { name: "get_weather", args: { city: "SF" } }
  });
  const functionResponse = out.contents[2].parts[0].functionResponse;
  assert.ok(functionResponse);
  assert.equal(functionResponse?.name, "get_weather");
  // String content must not be double-encoded.
  assert.equal(functionResponse?.response.result, "sunny");
});

test("tool_result with array content keeps structure and separates images", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "json-call_1", name: "json", input: {} }]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "json-call_1",
            content: [
              { type: "text", text: "alpha" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
            ]
          }
        ]
      }
    ]
  });
  const parts = out.contents[1].parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].functionResponse?.response.result, { type: "text", text: "alpha" });
  assert.deepEqual(parts[1].inline_data, { mime_type: "image/png", data: "aGVsbG8=" });
});

test("tool_result with multiple non-image blocks becomes a raw array", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "json-call_1", name: "json", input: {} }]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "json-call_1",
            content: [
              { type: "text", text: "alpha" },
              { type: "text", text: "beta" }
            ]
          }
        ]
      }
    ]
  });
  assert.deepEqual(out.contents[1].parts[0].functionResponse?.response.result, [
    { type: "text", text: "alpha" },
    { type: "text", text: "beta" }
  ]);
});

test("image block -> inline_data part", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
        ]
      }
    ]
  });
  const parts = out.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1].inline_data, { mime_type: "image/png", data: "aGVsbG8=" });
});

test("tool_choice auto/none/any/tool", () => {
  const base = {
    model: "gemini-2.5-pro",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [{ name: "json", description: "A JSON tool", input_schema: { type: "object", properties: {} } }]
  };
  assert.equal(convert({ ...base, tool_choice: { type: "auto" } }).toolConfig?.functionCallingConfig?.mode, "AUTO");
  assert.equal(convert({ ...base, tool_choice: { type: "none" } }).toolConfig?.functionCallingConfig?.mode, "NONE");
  assert.equal(convert({ ...base, tool_choice: { type: "any" } }).toolConfig?.functionCallingConfig?.mode, "ANY");
  const toolChoice = convert({ ...base, tool_choice: { type: "tool", name: "json" } }).toolConfig?.functionCallingConfig;
  assert.equal(toolChoice?.mode, "ANY");
  assert.deepEqual(toolChoice?.allowedFunctionNames, ["json"]);
});

test("thinking budget -> thinkingConfig.thinkingBudget", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(out.generationConfig?.thinkingConfig?.thinkingBudget, 2048);
});

test("adaptive thinking uses model max budget from catalog", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(out.generationConfig?.thinkingConfig?.thinkingBudget, 32768);
});

test("adaptive thinking with output_config.effort -> thinkingLevel", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    thinking: { type: "auto" },
    output_config: { effort: "LOW" },
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(out.generationConfig?.thinkingConfig?.thinkingLevel, "low");
});

test("sampling params map to generationConfig", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(out.generationConfig?.temperature, 0.7);
  assert.equal(out.generationConfig?.topP, 0.9);
  assert.equal(out.generationConfig?.topK, 40);
});

test("trailing model turn with unanswered functionCall is stripped", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "get_weather-call_1", name: "get_weather", input: {} }]
      }
    ]
  });
  assert.equal(out.contents.length, 1);
  assert.equal(out.contents[0].role, "user");
});

test("trailing model turn without functionCall is kept", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" }
    ]
  });
  assert.equal(out.contents.length, 2);
  assert.equal(out.contents[1].role, "model");
});

test("invalid function names are sanitized", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "weird/name-call_1", name: "weird/name", input: {} }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "weird/name-call_1", content: "ok" }]
      }
    ],
    tools: [
      { name: "weird/name", description: "has invalid chars", input_schema: { type: "object", properties: {} } }
    ]
  });
  // tool_use name derived from id prefix "weird/name" then sanitized.
  assert.equal(out.contents[0].parts[0].functionCall?.name, "weird_name");
  assert.equal(out.contents[1].parts[0].functionResponse?.name, "weird_name");
  assert.equal(out.tools?.[0].functionDeclarations?.[0].name, "weird_name");
});

test("tools input_schema -> parametersJsonSchema with cleaning", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "search",
        description: "Search",
        input_schema: {
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "SearchInput",
          properties: {
            query: { type: "string", format: "email", default: "x" },
            stale: { type: "string" }
          },
          required: ["query", "stale"]
        }
      }
    ]
  });
  const schema = out.tools?.[0].functionDeclarations?.[0].parametersJsonSchema as Record<string, unknown>;
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.title, undefined);
  const query = (schema.properties as Record<string, Record<string, unknown>>).query;
  assert.equal(query.format, undefined);
  assert.equal(query.default, undefined);
  assert.ok(typeof query.description === "string" && query.description.includes("format"));
  assert.deepEqual(schema.required, ["query", "stale"]);
});

test("message-level system role becomes a system-reminder user turn", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    system: [{ type: "text", text: "Top-level rules" }],
    messages: [
      { role: "user", content: "Hello" },
      { role: "system", content: "String mid-conversation rule" }
    ]
  });
  assert.equal(out.contents.length, 2);
  assert.equal(out.contents[1].role, "user");
  assert.equal(
    out.contents[1].parts[0].text,
    "<system-reminder>\nString mid-conversation rule\n</system-reminder>"
  );
});

test("empty text parts are skipped", () => {
  const out = convert({
    model: "gemini-2.5-pro",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "hello" },
          { type: "text", text: "" }
        ]
      }
    ]
  });
  assert.equal(out.contents[0].parts.length, 1);
  assert.equal(out.contents[0].parts[0].text, "hello");
});

test("default safety settings are attached", () => {
  const out = convert({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(out.safetySettings, defaultSafetySettings());
});
