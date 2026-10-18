import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { handle } from "../src/worker.js";
import { setup } from "./helpers.js";

test("Worker provisions and revokes through the real Python Gate HTTP API", async (t) => {
  const child = spawn(
    "python3",
    [new URL("./gate_fixture.py", import.meta.url).pathname],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (line) => {
      lines.close();
      resolve(Number(line));
    });
    child.once("exit", (code) =>
      reject(new Error(`Gate fixture exited ${code}`)),
    );
    child.stderr.on("data", () => {});
  });
  const c = setup(),
    fetcher = (_url, init) =>
      fetch(`http://127.0.0.1:${port}/__pingu_gate__/control/v1/devices`, init);
  async function request(path, data) {
    return handle(
      new Request("https://control.example.com" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + c.env.ADMIN_KEY,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      c.env,
      fetcher,
    );
  }
  const node = {
    id: "contract",
    name: "Contract node",
    origin: "https://contract.example.test",
    enabled: true,
    key: "contract-test-dedicated-key-" + "a".repeat(32),
  };
  assert.equal((await request("/api/nodes", { nodes: [node] })).status, 200);
  const id = "c".repeat(32),
    created = await request("/api/devices", {
      id,
      owner: "Contract",
      name: "Test",
    });
  assert.equal(created.status, 201);
  const d = await created.json();
  assert.equal(d.assignments[0].state, "active");
  const path = new URL(d.subscription).pathname,
    token = path.slice(3);
  const feed = await request(path);
  assert.equal(feed.status, 200);
  const uri = new URL((await feed.text()).trim());
  assert.equal(uri.searchParams.get("path"), "/__pingu_device__/v1/" + token);
  const nodeFeed = await fetch(
    `http://127.0.0.1:${port}/__pingu_gate__/devices/subscription/${token}`,
  );
  assert.equal(nodeFeed.status, 200);
  assert.equal((await request("/api/devices/" + id + "/sync", {})).status, 200);
  assert.equal(
    (await (await request("/api/devices/" + id + "/revoke", {})).json()).status,
    "revoked",
  );
  assert.equal((await request(path)).status, 403);
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}/__pingu_gate__/devices/subscription/${token}`,
      )
    ).status,
    403,
  );
  const replay = await fetcher("", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + node.key,
    },
    body: JSON.stringify({
      action: "provision",
      id: "cloud-" + id,
      token,
      owner: "Contract",
      name: "Test",
    }),
  });
  assert.equal(replay.status, 409);
});
