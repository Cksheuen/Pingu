import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config/config";
import { createWorker } from "../src/server/worker";

/**
 * Regression: an unrouted model used to fall through to a configured default
 * provider. The upstream then rejected a model it was never meant to serve, and
 * its error pointed at the wrong provider instead of at the missing route.
 */

function multiProviderConfig(routes: AppConfig["routes"]): AppConfig {
  return {
    port: 51120,
    host: "127.0.0.1",
    apiKeys: [],
    authDir: "/tmp/test-auth",
    providers: {
      "codex-subscription": {
        type: "openai",
        baseUrl: "https://chatgpt.test/backend-api/codex",
        apiKey: "codex_token",
        models: ["gpt-5.6-sol"]
      },
      cpa: {
        type: "anthropic",
        baseUrl: "https://cpa.test",
        apiKey: "cpa_key",
        models: ["gemini-3.7-flash-high", "gemini-3-flash"]
      }
    },
    routes
  };
}

function messagesRequest(model: string): Request {
  return new Request("http://127.0.0.1:51120/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }]
    })
  });
}

test("unrouted model returns 404 instead of being forwarded to another provider", async () => {
  const upstreamCalls: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    upstreamCalls.push(String(input));
    return new Response("unexpected upstream call", { status: 500 });
  };

  const worker = createWorker({ config: multiProviderConfig([]), fetch: mockFetch });
  const response = await worker.fetch(messagesRequest("gemini-3.8-flash-high"));

  assert.equal(response.status, 404);
  const body = (await response.json()) as { error?: { message?: string } };
  assert.match(String(body.error?.message), /no upstream provider configured for model 'gemini-3\.8-flash-high'/);

  // The request must not reach any provider — least of all an unrelated one.
  assert.deepEqual(upstreamCalls, []);
});

test("gemini- prefix route sends unenumerated gemini versions to cpa", async () => {
  let forwardedUrl = "";
  let forwardedModel = "";
  const mockFetch: typeof fetch = async (input, init) => {
    forwardedUrl = String(input);
    forwardedModel = JSON.parse(String(init?.body)).model;
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: forwardedModel,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const config = multiProviderConfig([{ modelPrefix: "gemini-", provider: "cpa" }]);
  const worker = createWorker({ config, fetch: mockFetch });
  const response = await worker.fetch(messagesRequest("gemini-3.8-flash-high"));

  assert.equal(response.status, 200);
  assert.ok(forwardedUrl.startsWith("https://cpa.test/v1/messages"));
  // The prefix rule keeps the model name intact (no stripPrefix).
  assert.equal(forwardedModel, "gemini-3.8-flash-high");
});

test("a single configured provider still serves any model", async () => {
  const config: AppConfig = {
    port: 51120,
    host: "127.0.0.1",
    apiKeys: [],
    authDir: "/tmp/test-auth",
    providers: {
      cpa: { type: "anthropic", baseUrl: "https://cpa.test", apiKey: "cpa_key" }
    },
    routes: []
  };

  const mockFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "whatever",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const worker = createWorker({ config, fetch: mockFetch });
  const response = await worker.fetch(messagesRequest("some-unknown-model"));
  assert.equal(response.status, 200);
});
