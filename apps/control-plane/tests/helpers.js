import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handle } from "../src/worker.js";
import { randomToken } from "../src/crypto.js";
export function setup() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL("../migrations/0001_control.sql", import.meta.url),
      "utf8",
    ),
  );
  class Statement {
    constructor(query, values = []) {
      this.query = query;
      this.values = values;
    }
    bind(...v) {
      return new Statement(this.query, v);
    }
    async first() {
      return sql.prepare(this.query).get(...this.values) || null;
    }
    async all() {
      return { results: sql.prepare(this.query).all(...this.values) };
    }
    async run() {
      return sql.prepare(this.query).run(...this.values);
    }
  }
  const env = {
    ADMIN_KEY: randomToken(),
    DATA_KEY: randomToken(),
    DB: {
      prepare: (s) => new Statement(s),
      async batch(statements) {
        sql.exec("BEGIN");
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          sql.exec("COMMIT");
          return results;
        } catch (e) {
          sql.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };
  const revoked = new Set(),
    provisioned = new Set(),
    calls = [];
  let down = new Set(),
    pause = null;
  const fetcher = async (url, init) => {
    const host = new URL(url).hostname,
      data = JSON.parse(init.body),
      key = `${host}:${data.id}`;
    calls.push({ host, ...data });
    assert.equal(init.redirect, "manual");
    assert.ok(init.headers.Authorization.startsWith("Bearer "));
    if (down.has(host)) throw new Error("node is down with secret details");
    if (data.action === "revoke") {
      revoked.add(key);
      return Response.json({ id: data.id, state: "revoked" });
    }
    if (pause) await pause;
    if (revoked.has(key))
      return Response.json({ error: "revoked" }, { status: 409 });
    provisioned.add(key);
    return Response.json({
      id: data.id,
      state: "active",
      subscription: `vless://11111111-1111-4111-8111-111111111111@${host}:443?type=ws&security=tls&path=${encodeURIComponent("/__pingu_device__/v1/" + data.token)}#test`,
    });
  };
  const request = async (path, data, headers = {}) =>
    handle(
      new Request("https://control.example.com" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + env.ADMIN_KEY,
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
      fetcher,
    );
  const node = (id, enabled = true) => ({
    id,
    name: `Node ${id}`,
    origin: `https://${id}.example.com`,
    enabled,
    key: randomToken(),
  });
  const add = async (nodes) => {
    const r = await request("/api/nodes", { nodes });
    assert.equal(r.status, 200, await r.text());
  };
  const create = async (id = "a".repeat(32)) => {
    const r = await request("/api/devices", {
      id,
      owner: "Owner",
      name: "Device",
    });
    assert.equal(r.status, 201);
    return r.json();
  };
  return {
    sql,
    env,
    request,
    node,
    add,
    create,
    calls,
    revoked,
    provisioned,
    setDown: (x) => (down = new Set(x)),
    setPause: (x) => (pause = x),
  };
}
