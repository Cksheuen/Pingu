import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AppConfig } from "../src/config/config";
import { CredentialPool } from "../src/oauth/credentialPool";
import { writeCredentialAtomic, type Credential } from "../src/oauth/credentials";
import { createWorker } from "../src/server/worker";

const BASE_URL = "http://127.0.0.1:51120";
const API_KEY = "dev-local-key";

function makeCredential(email: string, token: string, projectId: string): Credential {
  return {
    type: "antigravity",
    access_token: token,
    refresh_token: `refresh-${email}`,
    expires_in: 3600,
    timestamp: Date.now(),
    expired: "",
    email,
    project_id: projectId
  };
}

async function loadPool(authDir: string, credentials: Credential[]): Promise<CredentialPool> {
  for (const cred of credentials) await writeCredentialAtomic(authDir, cred);
  return CredentialPool.load(authDir);
}

function makeConfig(authDir: string): AppConfig {
  return { port: 51120, host: "127.0.0.1", apiKeys: [API_KEY], authDir, providers: {}, routes: [] };
}

interface FakeCall {
  url: string;
  authorization: string;
  body: unknown;
}

// Fake upstream: records every call and dispatches to the handler.
function fakeUpstream(handler: (call: FakeCall) => Response): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FakeCall = {
      url,
      authorization: headers.Authorization ?? "",
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const GEMINI_TEXT_RESPONSE = {
  candidates: [
    { content: { parts: [{ text: "hi there" }], role: "model" }, finishReason: "STOP", index: 0 }
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  responseId: "resp-1",
  modelVersion: "gemini-2.5-pro"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// Split an Anthropic SSE stream into [{event, data}] pairs.
function parseAnthropicSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    const lines = block.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    assert.ok(eventLine, `block missing event line: ${block}`);
    assert.ok(dataLine, `block missing data line: ${block}`);
    events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> });
  }
  return events;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("messages non-stream: envelope shape and anthropic response", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agw-worker-"));
  try {
    const pool = await loadPool(authDir, [makeCredential("alice@example.com", "token-alice", "project-a")]);
    const upstream = fakeUpstream(() => jsonResponse(GEMINI_TEXT_RESPONSE));
    const worker = createWorker({ config: makeConfig(authDir), pool, fetch: upstream.fetch });

    const response = await worker.fetch(
      postJson("/v1/messages", { model: "gemini-2.5-pro", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    );
    assert.equal(response.status, 200);
    const message = (await response.json()) as {
      type: string;
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(message.type, "message");
    assert.equal(message.content[0].type, "text");
    assert.equal(message.content[0].text, "hi there");
    assert.equal(message.usage.input_tokens, 5);
    assert.equal(message.usage.output_tokens, 2);

    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0];
    assert.ok(call.url.endsWith("/v1internal:generateContent"));
    assert.equal(call.authorization, "Bearer token-alice");
    const envelope = call.body as {
      requestType: string;
      userAgent: string;
      project: string;
      requestId: string;
      request: { contents: unknown[]; sessionId: string };
    };
    assert.equal(envelope.requestType, "agent");
    assert.equal(envelope.userAgent, "antigravity");
    assert.equal(envelope.project, "project-a");
    assert.ok(envelope.requestId.startsWith("agent-"));
    assert.ok(Array.isArray(envelope.request.contents));
    assert.match(envelope.request.sessionId, /^-\d+$/);
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});

test("messages stream: full anthropic event sequence", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agw-worker-"));
  try {
    const pool = await loadPool(authDir, [makeCredential("alice@example.com", "token-alice", "project-a")]);
    const upstream = fakeUpstream(() =>
      sseResponse([
        { candidates: [{ content: { parts: [{ text: "Hello" }], role: "model" }, index: 0 }] },
        {
          candidates: [
            { content: { parts: [{ text: " there" }], role: "model" }, finishReason: "STOP", index: 0 }
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          responseId: "resp-1",
          modelVersion: "gemini-2.5-pro"
        },
        "[DONE]"
      ])
    );
    const worker = createWorker({ config: makeConfig(authDir), pool, fetch: upstream.fetch });

    const response = await worker.fetch(
      postJson("/v1/messages", {
        model: "gemini-2.5-pro",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    );
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("Content-Type")?.startsWith("text/event-stream"));
    assert.ok(upstream.calls[0].url.includes("streamGenerateContent"));

    const events = parseAnthropicSse(await response.text());
    assert.deepEqual(
      events.map((event) => event.event),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop"
      ]
    );
    const textDeltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data.delta as { text: string }).text);
    assert.deepEqual(textDeltas, ["Hello", " there"]);
    const messageDelta = events.find((event) => event.event === "message_delta");
    assert.equal((messageDelta?.data.delta as { stop_reason: string }).stop_reason, "end_turn");
    assert.equal((messageDelta?.data.usage as { output_tokens: number }).output_tokens, 2);
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});

test("chat completions non-stream: openai response shape", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agw-worker-"));
  try {
    const pool = await loadPool(authDir, [makeCredential("alice@example.com", "token-alice", "project-a")]);
    const upstream = fakeUpstream(() => jsonResponse(GEMINI_TEXT_RESPONSE));
    const worker = createWorker({ config: makeConfig(authDir), pool, fetch: upstream.fetch });

    const response = await worker.fetch(
      postJson("/v1/chat/completions", { model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] })
    );
    assert.equal(response.status, 200);
    const completion = (await response.json()) as {
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string | null }>;
    };
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.choices[0].message.role, "assistant");
    assert.equal(completion.choices[0].message.content, "hi there");
    assert.equal(completion.choices[0].finish_reason, "stop");
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});

test("chat completions stream: chunks and [DONE] sentinel", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agw-worker-"));
  try {
    const pool = await loadPool(authDir, [makeCredential("alice@example.com", "token-alice", "project-a")]);
    const upstream = fakeUpstream(() =>
      sseResponse([
        { candidates: [{ content: { parts: [{ text: "Hello" }], role: "model" }, index: 0 }] },
        {
          candidates: [
            { content: { parts: [{ text: " there" }], role: "model" }, finishReason: "STOP", index: 0 }
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          responseId: "resp-1",
          modelVersion: "gemini-2.5-pro"
        }
      ])
    );
    const worker = createWorker({ config: makeConfig(authDir), pool, fetch: upstream.fetch });

    const response = await worker.fetch(
      postJson("/v1/chat/completions", {
        model: "gemini-2.5-pro",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    const blocks = text.split("\n\n").filter((block) => block.trim() !== "");
    assert.equal(blocks[blocks.length - 1], "data: [DONE]");

    const chunks = blocks.slice(0, -1).map((block) => {
      const line = block.split("\n").find((entry) => entry.startsWith("data: "));
      assert.ok(line, `block missing data line: ${block}`);
      return JSON.parse(line.slice(6)) as {
        choices: Array<{ delta: { content: string | null }; finish_reason: string | null }>;
      };
    });
    const contents = chunks.map((chunk) => chunk.choices[0].delta.content).filter((value) => value !== null);
    assert.deepEqual(contents, ["Hello", " there"]);
    const finalChunk = chunks[chunks.length - 1];
    assert.equal(finalChunk.choices[0].finish_reason, "stop");
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});

test("401 invalidates the credential and retries with the next one", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agw-worker-"));
  try {
    const pool = await loadPool(authDir, [
      makeCredential("alice@example.com", "token-alice", "project-a"),
      makeCredential("bob@example.com", "token-bob", "project-b")
    ]);
    const upstream = fakeUpstream((call) =>
      call.authorization === "Bearer token-alice"
        ? jsonResponse({ error: { message: "invalid credentials" } }, 401)
        : jsonResponse(GEMINI_TEXT_RESPONSE)
    );
    const worker = createWorker({ config: makeConfig(authDir), pool, fetch: upstream.fetch });

    const response = await worker.fetch(
      postJson("/v1/messages", { model: "gemini-2.5-pro", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    );
    assert.equal(response.status, 200);
    assert.equal(upstream.calls.length, 2);
    assert.equal(upstream.calls[0].authorization, "Bearer token-alice");
    assert.equal(upstream.calls[1].authorization, "Bearer token-bob");
    assert.equal((upstream.calls[1].body as { project: string }).project, "project-b");
    assert.equal(pool.size, 1, "the rejected credential should have been invalidated");
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});

test("all credentials rejected returns 503", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agw-worker-"));
  try {
    const pool = await loadPool(authDir, [makeCredential("alice@example.com", "token-alice", "project-a")]);
    const upstream = fakeUpstream(() => jsonResponse({ error: { message: "invalid credentials" } }, 401));
    const worker = createWorker({ config: makeConfig(authDir), pool, fetch: upstream.fetch });

    const response = await worker.fetch(
      postJson("/v1/messages", { model: "gemini-2.5-pro", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { message: string } };
    assert.ok(body.error.message.includes("rejected"));
    assert.equal(pool.size, 0);
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});

test("upstream 400 passes through as 400", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "agw-worker-"));
  try {
    const pool = await loadPool(authDir, [makeCredential("alice@example.com", "token-alice", "project-a")]);
    const upstream = fakeUpstream(() => jsonResponse({ error: { message: "bad request" } }, 400));
    const worker = createWorker({ config: makeConfig(authDir), pool, fetch: upstream.fetch });

    const response = await worker.fetch(
      postJson("/v1/messages", { model: "gemini-2.5-pro", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { message: string } };
    assert.ok(body.error.message.includes("bad request"));
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});
