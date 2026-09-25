import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config/config";
import { createWorker } from "../src/server/worker";
import { sanitizeSchema } from "../src/translate/common";

/**
 * Regression: Gemini requires every array to carry `items` and has no tuple
 * concept, so a JSON Schema 2020-12 `prefixItems`-only array was rejected with
 *   GenerateContentRequest...properties[where].items.items: missing field.
 * Tool schemas reached the Gemini-backed relay unsanitized.
 */

const TUPLE_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "object",
      properties: {
        where: {
          type: "array",
          maxItems: 10,
          items: {
            type: "array",
            prefixItems: [
              { type: "string" },
              { enum: ["eq", "ne"], type: "string" },
              {}
            ]
          }
        }
      }
    }
  }
} as const;

function schemaAt(root: unknown, path: string[]): Record<string, unknown> {
  let node = root as Record<string, unknown>;
  for (const key of path) node = node[key] as Record<string, unknown>;
  return node;
}

test("sanitizeSchema converts a prefixItems tuple into an items schema", () => {
  const cleaned = sanitizeSchema(structuredClone(TUPLE_SCHEMA));
  const where = schemaAt(cleaned, ["properties", "query", "properties", "where"]);
  const inner = where.items as Record<string, unknown>;

  // The inner array must end up with a concrete `items` and no `prefixItems`.
  assert.equal(inner.type, "array");
  assert.ok(!("prefixItems" in inner), "prefixItems must not survive");
  assert.ok(inner.items, "inner array needs an items schema");
  assert.equal((inner.items as Record<string, unknown>).type, "string");

  // The tuple shape is not silently lost — it is recorded for the model.
  assert.match(String(inner.description), /Tuple of 3 positional item\(s\)/);
});

test("sanitizeSchema keeps an existing items schema and only drops prefixItems", () => {
  const cleaned = sanitizeSchema({
    type: "array",
    items: { type: "number" },
    prefixItems: [{ type: "string" }]
  }) as Record<string, unknown>;

  assert.deepEqual(cleaned.items, { type: "number" });
  assert.ok(!("prefixItems" in cleaned));
});

test("sanitizeSchema gives an empty prefixItems array a usable items schema", () => {
  const cleaned = sanitizeSchema({ type: "array", prefixItems: [] }) as Record<string, unknown>;
  assert.ok(!("prefixItems" in cleaned));
  assert.deepEqual(cleaned.items, { type: "string" });
});

function configWith(geminiSchemaConstraints: boolean): AppConfig {
  return {
    port: 51120,
    host: "127.0.0.1",
    apiKeys: [],
    authDir: "/tmp/test-auth",
    providers: {
      cpa: {
        type: "anthropic",
        baseUrl: "https://cpa.test",
        apiKey: "k",
        models: ["gemini-3.8-flash-high"],
        geminiSchemaConstraints
      }
    },
    routes: []
  };
}

function toolRequest(): Request {
  return new Request("http://127.0.0.1:51120/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.8-flash-high",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", description: "d", input_schema: structuredClone(TUPLE_SCHEMA) }]
    })
  });
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "m",
      type: "message",
      role: "assistant",
      model: "gemini-3.8-flash",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn"
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("a gemini-constrained anthropic upstream receives sanitized tool schemas", async () => {
  let forwarded: any = null;
  const mockFetch: typeof fetch = async (_input, init) => {
    forwarded = JSON.parse(String(init?.body));
    return okResponse();
  };

  const worker = createWorker({ config: configWith(true), fetch: mockFetch });
  const response = await worker.fetch(toolRequest());
  assert.equal(response.status, 200);

  const inner = schemaAt(forwarded.tools[0].input_schema, [
    "properties",
    "query",
    "properties",
    "where",
    "items"
  ]);
  assert.ok(!("prefixItems" in inner), "prefixItems must not reach a Gemini upstream");
  assert.ok(inner.items, "Gemini requires items on every array");
});

test("a plain anthropic upstream keeps prefixItems untouched", async () => {
  let forwarded: any = null;
  const mockFetch: typeof fetch = async (_input, init) => {
    forwarded = JSON.parse(String(init?.body));
    return okResponse();
  };

  const worker = createWorker({ config: configWith(false), fetch: mockFetch });
  const response = await worker.fetch(toolRequest());
  assert.equal(response.status, 200);

  // Real Anthropic upstreams accept tuple schemas; sanitizing would degrade them.
  const inner = schemaAt(forwarded.tools[0].input_schema, [
    "properties",
    "query",
    "properties",
    "where",
    "items"
  ]);
  assert.ok(Array.isArray(inner.prefixItems), "prefixItems must survive for a real Anthropic upstream");
  assert.equal((inner.prefixItems as unknown[]).length, 3);
});

test("a tool-less request is forwarded without a tools key", async () => {
  let forwarded: any = null;
  const mockFetch: typeof fetch = async (_input, init) => {
    forwarded = JSON.parse(String(init?.body));
    return okResponse();
  };

  const worker = createWorker({ config: configWith(true), fetch: mockFetch });
  const response = await worker.fetch(
    new Request("http://127.0.0.1:51120/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash-high",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );

  assert.equal(response.status, 200);
  assert.ok(!("tools" in forwarded), "no tools key should be invented");
});
