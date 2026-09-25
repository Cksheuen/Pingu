import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config/config";
import { createWorker } from "../src/server/worker";

const baseConfig: AppConfig = {
  port: 51120,
  host: "127.0.0.1",
  apiKeys: ["dev-local-key"],
  authDir: "/tmp/antigravity-gateway-test-auth",
  providers: {},
  routes: []
};

function makeWorker(overrides: Partial<AppConfig> = {}) {
  return createWorker({ config: { ...baseConfig, ...overrides } });
}

test("healthz returns 200 ok", async () => {
  const response = await makeWorker().fetch(new Request("http://127.0.0.1:51120/healthz"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string };
  assert.equal(body.status, "ok");
});

test("models rejects requests without api key when keys are configured", async () => {
  const response = await makeWorker().fetch(new Request("http://127.0.0.1:51120/v1/models"));
  assert.equal(response.status, 401);
});

test("models returns the static catalog with a valid key", async () => {
  const response = await makeWorker().fetch(
    new Request("http://127.0.0.1:51120/v1/models", { headers: { Authorization: "Bearer dev-local-key" } })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 8);
  const ids = body.data.map((model) => model.id);
  for (const expected of ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro-preview"]) {
    assert.ok(ids.includes(expected), `catalog should include ${expected}`);
  }
});

test("messages returns 503 without credentials", async () => {
  const response = await makeWorker().fetch(
    new Request("http://127.0.0.1:51120/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer dev-local-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-2.5-pro", messages: [] })
    })
  );
  assert.equal(response.status, 503);
});

test("unknown route returns 404", async () => {
  const response = await makeWorker().fetch(new Request("http://127.0.0.1:51120/nope"));
  assert.equal(response.status, 404);
});
