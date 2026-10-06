import test from "node:test";
import assert from "node:assert/strict";
import worker, { handle } from "../src/worker.js";
import { randomToken, open, seal } from "../src/crypto.js";
import { setup } from "./helpers.js";
test("multiple VPS, stable feed, storage encryption, retries and cached downloads", async () => {
  const t = setup();
  await t.add([t.node("a"), t.node("b")]);
  const d = await t.create();
  assert.equal(d.assignments.length, 2);
  assert.ok(d.assignments.every((a) => a.state === "active"));
  const token = new URL(d.subscription).pathname.split("/").pop();
  const records =
    JSON.stringify(t.sql.prepare("SELECT * FROM devices").all()) +
    JSON.stringify(t.sql.prepare("SELECT * FROM assignments").all());
  assert.ok(!records.includes(token));
  assert.ok(!records.includes("vless://"));
  const uri = new URL(d.subscription).pathname;
  t.setDown(["a.example.com", "b.example.com"]);
  const before = t.calls.length;
  const feed = await t.request(uri);
  assert.equal(feed.status, 200);
  assert.equal((await feed.text()).trim().split("\n").length, 2);
  assert.equal(t.calls.length, before);
  const clash = await (await t.request(uri + "?format=clash")).json();
  assert.equal(clash.proxies.length, 2);
  assert.ok(clash.proxies.every((p) => p["ws-opts"].path.endsWith(token)));
  const again = await t.create();
  assert.equal(again.subscription, d.subscription);
  assert.equal(t.sql.prepare("SELECT COUNT(*) n FROM devices").get().n, 1);
  const retry = await (
    await t.request("/api/devices/" + d.id + "/sync", {})
  ).json();
  assert.ok(retry.assignments.every((a) => a.state === "active" && a.error));
  assert.equal((await t.request(uri)).status, 200);
  assert.equal((await t.request(uri + "?format=bad")).status, 400);
});
test("adding and hiding nodes changes contents but not device URL; immutable origin protects revocation", async () => {
  const t = setup();
  await t.add([t.node("a")]);
  const d = await t.create();
  await t.add([t.node("b")]);
  await t.request("/api/devices/" + d.id + "/sync", {});
  const second = await (
    await t.request("/api/devices/" + d.id + "/link", {})
  ).json();
  assert.equal(second.subscription, d.subscription);
  const path = new URL(d.subscription).pathname;
  assert.equal(
    (await (await t.request(path)).text()).trim().split("\n").length,
    2,
  );
  await t.add([{ ...t.node("a", false), key: undefined }]);
  assert.equal(
    (await (await t.request(path)).text()).trim().split("\n").length,
    1,
  );
  const n = { ...t.node("a"), origin: "https://replacement.example.com" };
  assert.equal((await t.request("/api/nodes", { nodes: [n] })).status, 409);
  const r = await (
    await t.request("/api/devices/" + d.id + "/revoke", {})
  ).json();
  assert.equal(r.status, "revoked");
  assert.equal(t.revoked.size, 2);
});
test("partial revoke blocks feed immediately, retries failed nodes, never silently succeeds", async () => {
  const t = setup();
  await t.add([t.node("a"), t.node("b")]);
  const d = await t.create();
  t.setDown(["b.example.com"]);
  let r = await (
    await t.request("/api/devices/" + d.id + "/revoke", {})
  ).json();
  assert.equal(r.status, "revoking");
  assert.equal((await t.request(new URL(d.subscription).pathname)).status, 403);
  assert.equal(
    (await t.request("/api/devices/" + d.id + "/sync", {})).status,
    409,
  );
  t.setDown([]);
  r = await (await t.request("/api/devices/" + d.id + "/revoke", {})).json();
  assert.equal(r.status, "revoked");
  assert.ok(
    t.sql
      .prepare("SELECT * FROM assignments")
      .all()
      .every((a) => a.state === "revoked" && !a.uri_cipher),
  );
});
test("revocation racing delayed provisioning remains revoked on both sides", async () => {
  const t = setup();
  await t.add([t.node("a")]);
  let release;
  t.setPause(new Promise((resolve) => (release = resolve)));
  const id = "b".repeat(32);
  const creating = t.request("/api/devices", {
    id,
    owner: "Owner",
    name: "Device",
  });
  while (!t.calls.length) await new Promise((resolve) => setImmediate(resolve));
  const r = await (
    await t.request("/api/devices/" + id + "/revoke", {})
  ).json();
  assert.equal(r.status, "revoked");
  release();
  assert.equal((await creating).status, 409);
  assert.equal(t.provisioned.size, 0);
  assert.equal(
    t.sql.prepare("SELECT status FROM devices").get().status,
    "revoked",
  );
  assert.equal(
    t.sql.prepare("SELECT state FROM assignments").get().state,
    "revoked",
  );
});
test("cookie authentication, CSRF, rate limit and no secret data in state", async () => {
  const t = setup();
  await t.add([t.node("a")]);
  await t.create();
  const r = await t.request("/api/state");
  const state = await r.text();
  assert.ok(!state.includes("cipher"));
  assert.ok(!state.includes("token_hash"));
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(
    (await t.request("/api/state", undefined, { Authorization: "" })).status,
    401,
  );
  assert.equal(
    (
      await t.request(
        "/api/login",
        { key: t.env.ADMIN_KEY },
        { Authorization: "", Origin: "https://evil.example.com" },
      )
    ).status,
    403,
  );
  const login = await t.request(
    "/api/login",
    { key: t.env.ADMIN_KEY },
    { Authorization: "", Origin: "https://control.example.com" },
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie");
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(
    (
      await t.request("/api/state", undefined, {
        Authorization: "",
        Cookie: cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await t.request(
        "/api/nodes",
        { nodes: [t.node("b")] },
        {
          Authorization: "",
          Cookie: cookie,
          Origin: "https://evil.example.com",
        },
      )
    ).status,
    403,
  );
  for (let i = 0; i < 19; i++)
    await t.request(
      "/api/login",
      { key: "bad" },
      { Origin: "https://control.example.com" },
    );
  assert.equal(
    (
      await t.request(
        "/api/login",
        { key: t.env.ADMIN_KEY },
        { Origin: "https://control.example.com" },
      )
    ).status,
    429,
  );
});
test("node array validation is atomic and credentials stay bound to their record", async () => {
  const t = setup();
  const a = t.node("a"),
    b = { ...t.node("b"), origin: "https://127.0.0.1" };
  assert.equal((await t.request("/api/nodes", { nodes: [a, b] })).status, 400);
  assert.equal(t.sql.prepare("SELECT COUNT(*) n FROM nodes").get().n, 0);
  const c = await seal("secret", t.env.DATA_KEY, "node:a");
  await assert.rejects(open(c, t.env.DATA_KEY, "node:b"));
  const req = new Request("https://control.example.com/api/nodes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + t.env.ADMIN_KEY,
    },
    body: "x".repeat(32769),
  });
  assert.equal((await handle(req, t.env)).status, 413);
});
test("Worker entrypoint does not use execution context as a fetch function", async () => {
  const r = await worker.fetch(
    new Request("https://control.example.com/health"),
    {},
    { waitUntil() {} },
  );
  assert.equal(r.status, 200);
});
