import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexOAuthProvider } from "../src/providers/codexOAuthProvider";
import { CodexAuthManager } from "../src/oauth/codexAuth";
import { anthropicToResponsesRequest, ResponsesToAnthropicSseTranslator } from "../src/translate/anthropicToResponses";

function jwt(exp: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp })}.sig`;
}

function authFile(accessToken = jwt(Math.floor(Date.now() / 1000) + 3600)): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "codex-oauth-test-"));
  const path = join(dir, "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: accessToken, refresh_token: "refresh-old", account_id: "acct-test" }
    })
  );
  return { dir, path };
}

test("Anthropic Messages maps to Responses input, tools, and encrypted reasoning include", () => {
  const request = anthropicToResponsesRequest(
    {
      model: "gpt-5.6-sol",
      system: "Be concise",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "weather", input: { city: "SF" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "sunny" }] }
      ],
      tools: [{ name: "weather", description: "Get weather", input_schema: { type: "object" } }],
      stream: true
    },
    "gpt-5.6-sol"
  );

  assert.equal(request.instructions, "Be concise");
  assert.equal(request.stream, true);
  assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
  assert.equal((request.tools?.[0] as { type: string }).type, "function");
  assert.ok((request.input as Array<Record<string, unknown>>).some((item) => item.type === "function_call"));
  assert.ok((request.input as Array<Record<string, unknown>>).some((item) => item.type === "function_call_output"));
});

test("replayed encrypted reasoning includes the required Responses summary field", () => {
  const request = anthropicToResponsesRequest({
    model: "gpt-5.6-sol",
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden", signature: "encrypted-signature" }]
      },
      { role: "user", content: "continue" }
    ]
  }, "gpt-5.6-sol");

  const reasoning = (request.input as Array<Record<string, unknown>>).find((item) => item.type === "reasoning");
  assert.deepEqual(reasoning, {
    type: "reasoning",
    summary: [],
    encrypted_content: "encrypted-signature"
  });
});

test("message-level system turns are remapped because Codex subscription rejects role=system", () => {
  const request = anthropicToResponsesRequest({
    model: "gpt-5.6-sol",
    messages: [
      { role: "system", content: "internal rule" },
      { role: "user", content: "continue" }
    ]
  }, "gpt-5.6-sol");

  const messages = (request.input as Array<Record<string, unknown>>).filter((item) => item.type === "message");
  assert.deepEqual(messages.map((item) => item.role), ["user", "user"]);
});

test("Responses SSE maps text and function calls to Anthropic SSE", () => {
  const translator = new ResponsesToAnthropicSseTranslator("gpt-5.6-sol");
  const events: string[] = [];
  for (const payload of [
    { type: "response.created", response: { id: "resp-1", model: "gpt-5.6-sol" } },
    { type: "response.output_text.delta", item_id: "msg-1", delta: "hello" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "weather" } },
    { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: '{"city":"SF"}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "weather" } },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        model: "gpt-5.6-sol",
        output: [{ type: "function_call" }],
        usage: { input_tokens: 4, output_tokens: 6 }
      }
    }
  ]) {
    events.push(...translator.feed(JSON.stringify(payload)));
  }
  const parsed = events.map((event) => JSON.parse(event.split("data: ")[1]) as Record<string, unknown>);
  assert.equal(parsed[0].type, "message_start");
  assert.ok(parsed.some((event) => (event.content_block as Record<string, unknown> | undefined)?.type === "tool_use"));
  assert.ok(parsed.some((event) => (event.delta as Record<string, unknown> | undefined)?.type === "input_json_delta"));
  const messageDelta = parsed.find((event) => event.type === "message_delta") as Record<string, unknown>;
  assert.deepEqual(messageDelta.usage, { input_tokens: 4, output_tokens: 6 });
  assert.equal(parsed.at(-1)?.type, "message_stop");
});

test("Codex OAuth provider forwards Responses with subscription headers", async () => {
  const fixture = authFile();
  try {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body));
      const sse = [
        { type: "response.created", response: { id: "resp-test", model: "gpt-5.6-sol" } },
        { type: "response.output_text.delta", item_id: "msg-1", delta: "SUBSCRIPTION_OK" },
        { type: "response.completed", response: { id: "resp-test", model: "gpt-5.6-sol", usage: { input_tokens: 1, output_tokens: 1 }, output: [] } }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const provider = new CodexOAuthProvider({ id: "codex-subscription", authFile: fixture.path, fetch: mockFetch });
    const response = await provider.handleMessages(
      { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Say hi" }], stream: true },
      new Request("http://local/v1/messages", { headers: { "x-client-request-id": "req-1" } }),
      "gpt-5.6-sol"
    );
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /SUBSCRIPTION_OK/);
    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(requestBody?.model, "gpt-5.6-sol");
    assert.equal(requestHeaders?.get("ChatGPT-Account-ID"), "acct-test");
    assert.equal(requestHeaders?.get("originator"), "codex_cli_rs");
    assert.equal(requestHeaders?.get("authorization"), `Bearer ${JSON.parse(readFileSync(fixture.path, "utf8")).tokens.access_token}`);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Codex OAuth refresh uses the official JSON token exchange and persists rotation", async () => {
  const fixture = authFile(jwt(Math.floor(Date.now() / 1000) - 60));
  try {
    let refreshBody: Record<string, unknown> | undefined;
    const manager = new CodexAuthManager(fixture.path, async (input, init) => {
      assert.equal(String(input), "https://auth.openai.com/oauth/token");
      refreshBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new" }), { status: 200 });
    });
    const headers = await manager.getAuthHeaders();
    assert.equal(headers.accessToken, "access-new");
    assert.deepEqual(refreshBody, { client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "refresh-old" });
    const saved = JSON.parse(readFileSync(fixture.path, "utf8"));
    assert.equal(saved.tokens.refresh_token, "refresh-new");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
