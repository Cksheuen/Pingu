import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYAML } from "yaml";
import { renderSubscription } from "../src/subscription.js";
import { setup } from "./helpers.js";

const entries = [
  {
    label: '香港: "节点"\n第二行',
    uri: "vless://11111111-1111-4111-8111-111111111111@node.example.com:443?type=ws&security=tls&sni=tls.example.com&host=ws.example.com&fp=firefox&path=%2F__pingu_device__%2Fv1%2Fsample-token",
  },
];
const iosLines = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

test("Clash remains YAML after iOS line trimming, with names and WS/TLS credentials intact", () => {
  const text = renderSubscription(entries, "clash");
  assert.throws(() => JSON.parse(text));
  const config = parseYAML(iosLines(text));
  assert.deepEqual(config, parseYAML(text));
  assert.equal(config.ipv6, false);
  const node = config.proxies[0];
  assert.equal(node.name, entries[0].label);
  assert.equal(node.servername, "tls.example.com");
  assert.equal(node["client-fingerprint"], "firefox");
  assert.deepEqual(node["ws-opts"], {
    path: "/__pingu_device__/v1/sample-token",
    headers: { Host: "ws.example.com" },
  });
  assert.deepEqual(config["proxy-groups"][0].proxies, [entries[0].label]);
});

test("Hiddify format is native sing-box; general format keeps the original protocol parameters", () => {
  const config = JSON.parse(iosLines(renderSubscription(entries, "sing-box")));
  assert.deepEqual(config.outbounds, [
    {
      type: "vless",
      tag: entries[0].label,
      server: "node.example.com",
      server_port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      packet_encoding: "xudp",
      tls: {
        enabled: true,
        server_name: "tls.example.com",
        utls: { enabled: true, fingerprint: "firefox" },
      },
      transport: {
        type: "ws",
        path: "/__pingu_device__/v1/sample-token",
        headers: { Host: "ws.example.com" },
      },
    },
  ]);
  const original = new URL(entries[0].uri),
    rendered = new URL(renderSubscription(entries, ""));
  assert.equal(
    rendered.origin + rendered.pathname + rendered.search,
    original.origin + original.pathname + original.search,
  );
  assert.equal(decodeURIComponent(rendered.hash.slice(1)), entries[0].label);
});

test("all formats and QR downloads respect device revocation, hidden nodes and cache policy", async () => {
  const t = setup();
  await t.add([t.node("a"), t.node("b")]);
  const d = await t.create();
  const path = new URL(d.subscription).pathname;
  await t.add([{ ...t.node("b", false), key: undefined }]);
  const native = await t.request(path + "?format=sing-box");
  assert.match(native.headers.get("content-type"), /application\/json/);
  const nodes = (await native.json()).outbounds;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].server, "a.example.com");
  for (const format of ["", "?format=clash", "?format=sing-box"]) {
    const qr = await t.request(path + "/qr" + format, undefined, {
      Authorization: "",
    });
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get("cache-control"), "no-store");
    assert.match(qr.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg /);
  }
  assert.equal((await t.request(path + "/qr?format=bad")).status, 400);
  assert.equal((await t.request(path + "/qr/extra")).status, 403);
  await t.request("/api/devices/" + d.id + "/revoke", {});
  for (const suffix of ["", "/qr"])
    for (const format of ["", "?format=clash", "?format=sing-box"])
      assert.equal((await t.request(path + suffix + format)).status, 403);
});
