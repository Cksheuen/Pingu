import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config/config";
import { createWorker } from "../src/server/worker";
import { OpenAiToAnthropicSseTranslator } from "../src/translate/anthropicToOpenai";
import { openAiToAnthropicRequest } from "../src/translate/openaiToAnthropic";

test("multi-provider: /v1/models aggregates manual static models and auto-discovered models", async () => {
  const config: AppConfig = {
    port: 51120,
    host: "127.0.0.1",
    apiKeys: [],
    authDir: "/tmp/test-auth",
    providers: {
      "super-relay": {
        type: "anthropic",
        baseUrl: "https://super-relay.test",
        apiKey: "plat_test_key",
        models: ["model_api/experimental_0812_256k", "model_hub/es1_orange_o48"]
      },
      "cpa": {
        type: "anthropic",
        baseUrl: "https://cpa.test",
        apiKey: "cpa_key",
        models: ["cpa-claude-3-7-sonnet"]
      },
      "official-openai": {
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKey: "sk-official-openai",
        autoDiscoverModels: true
      }
    },
    routes: [
      { modelPrefix: "cpa/", provider: "cpa", stripPrefix: true }
    ]
  };

  const mockFetch: typeof fetch = async (input, init) => {
    const urlStr = String(input);
    if (urlStr.includes("api.openai.test/v1/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "gpt-4o" }, { id: "o3-mini" }, { id: "o1" }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const worker = createWorker({ config, fetch: mockFetch });
  const response = await worker.fetch(new Request("http://127.0.0.1:51120/v1/models"));
  assert.equal(response.status, 200);

  const body = (await response.json()) as { object: string; data: Array<{ id: string }> };
  assert.equal(body.object, "list");
  const modelIds = body.data.map((m) => m.id);

  // Should contain manually declared models
  assert.ok(modelIds.includes("model_api/experimental_0812_256k"));
  assert.ok(modelIds.includes("model_hub/es1_orange_o48"));
  assert.ok(modelIds.includes("cpa-claude-3-7-sonnet"));

  // Should contain auto-discovered official models
  assert.ok(modelIds.includes("gpt-4o"));
  assert.ok(modelIds.includes("o3-mini"));
  assert.ok(modelIds.includes("o1"));
});

test("multi-provider: Codex ChatCompletions routed to Super Relay with OpenAI->Anthropic translation", async () => {
  let forwardedUrl = "";
  let forwardedBody: any = null;
  let forwardedApiKey: string | null = null;

  const config: AppConfig = {
    port: 51120,
    host: "127.0.0.1",
    apiKeys: [],
    authDir: "/tmp/test-auth",
    providers: {
      "super-relay": {
        type: "anthropic",
        baseUrl: "https://super-relay.test",
        apiKey: "plat_test_relay_token",
        models: ["model_api/experimental_0812_256k"]
      },
      "official-openai": {
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKey: "sk-official",
        models: ["gpt-4o"]
      }
    },
    routes: []
  };

  const mockFetch: typeof fetch = async (input, init) => {
    forwardedUrl = String(input);
    const h = new Headers(init?.headers);
    forwardedApiKey = h.get("x-api-key");
    if (init?.body) {
      forwardedBody = JSON.parse(String(init.body));
    }

    if (forwardedUrl.includes("super-relay.test/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_anthropic_123",
          type: "message",
          role: "assistant",
          model: "model_api/experimental_0812_256k",
          content: [{ type: "text", text: "Hello from Super Relay!" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 15 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  };

  const worker = createWorker({ config, fetch: mockFetch });

  // Client (Codex) sends OpenAI Chat Completion request for super-relay model
  const req = new Request("http://127.0.0.1:51120/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "model_api/experimental_0812_256k",
      messages: [
        { role: "system", content: "You are a subagent." },
        { role: "user", content: "Run subagent task." }
      ]
    })
  });

  const response = await worker.fetch(req);
  assert.equal(response.status, 200);

  // Upstream should have received Anthropic Messages wire format
  assert.ok(forwardedUrl.includes("super-relay.test/v1/messages"));
  assert.equal(forwardedApiKey, "plat_test_relay_token");
  assert.equal(forwardedBody.model, "model_api/experimental_0812_256k");
  assert.equal(forwardedBody.system, "You are a subagent.");
  assert.equal(forwardedBody.messages[0].role, "user");
  assert.equal(forwardedBody.messages[0].content, "Run subagent task.");

  // Client (Codex) receives OpenAI formatted response
  const respBody = (await response.json()) as any;
  assert.equal(respBody.object, "chat.completion");
  assert.equal(respBody.choices[0].message.role, "assistant");
  assert.equal(respBody.choices[0].message.content, "Hello from Super Relay!");
  assert.equal(respBody.choices[0].finish_reason, "stop");
  assert.equal(respBody.usage.prompt_tokens, 10);
  assert.equal(respBody.usage.completion_tokens, 15);
});

test("multi-provider: prefix routing and stripPrefix for CPA provider", async () => {
  let forwardedUrl = "";
  let forwardedBody: any = null;

  const config: AppConfig = {
    port: 51120,
    host: "127.0.0.1",
    apiKeys: [],
    authDir: "/tmp/test-auth",
    providers: {
      "cpa": {
        type: "anthropic",
        baseUrl: "https://cpa.test",
        apiKey: "cpa_secret_key"
      }
    },
    routes: [
      { modelPrefix: "cpa/", provider: "cpa", stripPrefix: true }
    ]
  };

  const mockFetch: typeof fetch = async (input, init) => {
    forwardedUrl = String(input);
    if (init?.body) {
      forwardedBody = JSON.parse(String(init.body));
    }
    return new Response(
      JSON.stringify({
        id: "msg_cpa_1",
        type: "message",
        role: "assistant",
        model: "claude-3-7-sonnet",
        content: [{ type: "text", text: "CPA response" }],
        stop_reason: "end_turn"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const worker = createWorker({ config, fetch: mockFetch });

  // Claude Code sends messages request with "cpa/claude-3-7-sonnet"
  const req = new Request("http://127.0.0.1:51120/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cpa/claude-3-7-sonnet",
      messages: [{ role: "user", content: "Hi" }]
    })
  });

  const response = await worker.fetch(req);
  assert.equal(response.status, 200);

  // Upstream should receive stripped target model "claude-3-7-sonnet"
  assert.ok(forwardedUrl.includes("cpa.test/v1/messages"));
  assert.equal(forwardedBody.model, "claude-3-7-sonnet");
});

test("multi-provider: Claude Code Messages routed to OpenAI Provider with Anthropic->OpenAI translation", async () => {
  let forwardedUrl = "";
  let forwardedBody: any = null;

  const config: AppConfig = {
    port: 51120,
    host: "127.0.0.1",
    apiKeys: [],
    authDir: "/tmp/test-auth",
    providers: {
      "official-openai": {
        type: "openai",
        baseUrl: "https://api.openai.test/v1",
        apiKey: "sk-test",
        models: ["gpt-4o"]
      }
    },
    routes: []
  };

  const mockFetch: typeof fetch = async (input, init) => {
    forwardedUrl = String(input);
    if (init?.body) {
      forwardedBody = JSON.parse(String(init.body));
    }

    return new Response(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello from GPT-4o" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30 }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const worker = createWorker({ config, fetch: mockFetch });

  // Claude Code sends Anthropic Messages request for "gpt-4o"
  const req = new Request("http://127.0.0.1:51120/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      system: "System prompt",
      messages: [{ role: "user", content: "User question" }]
    })
  });

  const response = await worker.fetch(req);
  assert.equal(response.status, 200);

  // Upstream should receive OpenAI format
  assert.ok(forwardedUrl.includes("api.openai.test/v1/chat/completions"));
  assert.equal(forwardedBody.model, "gpt-4o");
  assert.equal(forwardedBody.messages[0].role, "system");
  assert.equal(forwardedBody.messages[0].content, "System prompt");
  assert.equal(forwardedBody.messages[1].role, "user");
  assert.equal(forwardedBody.messages[1].content, "User question");

  // Client receives Anthropic format
  const respJson = (await response.json()) as any;
  assert.equal(respJson.type, "message");
  assert.equal(respJson.role, "assistant");
  assert.equal(respJson.content[0].type, "text");
  assert.equal(respJson.content[0].text, "Hello from GPT-4o");
  assert.equal(respJson.stop_reason, "end_turn");
  assert.equal(respJson.usage.input_tokens, 20);
  assert.equal(respJson.usage.output_tokens, 30);
});

test("OpenAiToAnthropicSseTranslator: emits message_delta and message_stop on finish() if upstream abruptly ends without finish_reason", () => {
  const translator = new OpenAiToAnthropicSseTranslator("gpt-4o");

  const chunk1 = JSON.stringify({
    id: "chatcmpl-test",
    model: "gpt-4o",
    choices: [{ delta: { role: "assistant", content: "Hello world" } }]
  });

  const events: string[] = [];
  events.push(...translator.feed(chunk1));
  events.push(...translator.finish());

  const parsed = events.map((raw) => {
    const match = raw.match(/^event: (.*)\ndata: (.*)\n\n$/s);
    assert.ok(match, `event should match SSE shape: ${raw}`);
    return { event: match[1], data: JSON.parse(match[2]) as Record<string, unknown> };
  });

  const eventTypes = parsed.map((e) => e.event);
  assert.deepEqual(eventTypes, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);

  const delta = parsed.find((e) => e.event === "message_delta")?.data as any;
  assert.equal(delta.delta.stop_reason, "end_turn");
});

test("OpenAiToAnthropicSseTranslator: does not duplicate message_stop when finish_reason was already received", () => {
  const translator = new OpenAiToAnthropicSseTranslator("gpt-4o");

  const chunk1 = JSON.stringify({
    id: "chatcmpl-test",
    model: "gpt-4o",
    choices: [{ delta: { role: "assistant", content: "Hello" } }]
  });
  const chunk2 = JSON.stringify({
    id: "chatcmpl-test",
    model: "gpt-4o",
    choices: [{ delta: {}, finish_reason: "stop" }]
  });

  const events: string[] = [];
  events.push(...translator.feed(chunk1));
  events.push(...translator.feed(chunk2));
  events.push(...translator.finish());

  const parsed = events.map((raw) => {
    const match = raw.match(/^event: (.*)\ndata: (.*)\n\n$/s);
    assert.ok(match, `event should match SSE shape: ${raw}`);
    return { event: match[1], data: JSON.parse(match[2]) as Record<string, unknown> };
  });

  const stopEvents = parsed.filter((e) => e.event === "message_stop");
  assert.equal(stopEvents.length, 1);
});

test("openaiToAnthropic: tool message and object content converts to tool_result without error", () => {
  const req = openAiToAnthropicRequest({
    model: "claude-3-7-sonnet",
    messages: [
      { role: "user", content: "read file" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "readFile", arguments: '{"path":"a.txt"}' }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: { lines: ["line1", "line2"] } as any
      }
    ]
  });

  assert.equal(req.messages?.length, 3);
  const toolMsg = req.messages?.[2];
  assert.equal(toolMsg?.role, "user");
  const toolResult = (toolMsg?.content as any[])[0];
  assert.equal(toolResult.type, "tool_result");
  assert.deepEqual(toolResult.content, { lines: ["line1", "line2"] });
});

