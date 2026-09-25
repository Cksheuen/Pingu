import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { deriveSessionId, wrapAntigravityEnvelope } from "../src/upstream/envelope";
import type { GeminiRequestBody } from "../src/translate/types";

const MASK = 0x7fffffffffffffffn;

function expectedSessionId(text: string): string {
  const value = createHash("sha256").update(text).digest().readBigUInt64BE(0) & MASK;
  return `-${value.toString(10)}`;
}

test("deriveSessionId hashes the first user text part", () => {
  const contents = [
    { role: "model", parts: [{ text: "ignored" }] },
    { role: "user", parts: [{ text: "hello world" }] }
  ];
  assert.equal(deriveSessionId(contents), expectedSessionId("hello world"));
});

test("deriveSessionId is stable across calls", () => {
  const contents = [{ role: "user", parts: [{ text: "same input" }] }];
  assert.equal(deriveSessionId(contents), deriveSessionId(contents));
});

test("deriveSessionId skips empty text and non-user roles", () => {
  const contents = [
    { role: "user", parts: [{ text: "" }] },
    { role: "model", parts: [{ text: "real answer" }] },
    { role: "user", parts: [{ text: "second user" }] }
  ];
  assert.equal(deriveSessionId(contents), expectedSessionId("second user"));
});

test("deriveSessionId falls back to a random dashed id", () => {
  const first = deriveSessionId([]);
  const second = deriveSessionId(undefined);
  assert.match(first, /^-\d+$/);
  assert.match(second, /^-\d+$/);
  assert.notEqual(first, second);
});

test("wrapAntigravityEnvelope nests the gemini body under request", () => {
  const geminiBody: GeminiRequestBody = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: { parts: [{ text: "be brief" }] },
    generationConfig: { temperature: 0.5 },
    safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } }
  };
  const envelope = wrapAntigravityEnvelope("gemini-2.5-pro", geminiBody, "project-42");

  assert.equal(envelope.model, "gemini-2.5-pro");
  assert.equal(envelope.userAgent, "antigravity");
  assert.equal(envelope.requestType, "agent");
  assert.equal(envelope.project, "project-42");
  assert.match(envelope.requestId, /^agent-[0-9a-f-]{36}$/);

  const request = envelope.request as Record<string, unknown>;
  assert.deepEqual(request.contents, geminiBody.contents);
  assert.deepEqual(request.systemInstruction, geminiBody.systemInstruction);
  assert.deepEqual(request.generationConfig, geminiBody.generationConfig);
  // safetySettings must not reach the upstream; toolConfig moves into request.
  assert.equal("safetySettings" in request, false);
  assert.deepEqual(request.toolConfig, geminiBody.toolConfig);
  assert.equal(request.sessionId, expectedSessionId("hi"));
});

test("wrapAntigravityEnvelope omits toolConfig when absent", () => {
  const envelope = wrapAntigravityEnvelope(
    "gemini-2.5-flash",
    { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    "project-1"
  );
  assert.equal("toolConfig" in (envelope.request as object), false);
  assert.equal(envelope.project, "project-1");
});

test("requestId is unique per envelope", () => {
  const body: GeminiRequestBody = { contents: [{ role: "user", parts: [{ text: "x" }] }] };
  const first = wrapAntigravityEnvelope("m", body, "p").requestId;
  const second = wrapAntigravityEnvelope("m", body, "p").requestId;
  assert.notEqual(first, second);
  assert.ok(first.startsWith("agent-"));
  assert.ok(randomUUID !== undefined);
});
