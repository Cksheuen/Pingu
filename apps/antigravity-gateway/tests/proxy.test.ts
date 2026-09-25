import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { noProxyMatches, proxyDispatcher } from "../src/net/proxy";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

const saved: Record<string, string | undefined> = {};
for (const key of PROXY_VARS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of PROXY_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("no proxy env means direct connection", () => {
  for (const key of PROXY_VARS) delete process.env[key];
  assert.equal(proxyDispatcher("https://oauth2.googleapis.com/token"), undefined);
});

test("HTTPS_PROXY takes precedence and builds a dispatcher", () => {
  for (const key of PROXY_VARS) delete process.env[key];
  process.env.HTTPS_PROXY = "http://127.0.0.1:2080";
  process.env.HTTP_PROXY = "http://127.0.0.1:9999";
  const dispatcher = proxyDispatcher("https://oauth2.googleapis.com/token");
  assert.notEqual(dispatcher, undefined);
});

test("lowercase https_proxy is honored", () => {
  for (const key of PROXY_VARS) delete process.env[key];
  process.env.https_proxy = "http://127.0.0.1:2080";
  assert.notEqual(proxyDispatcher("https://cloudcode-pa.googleapis.com/"), undefined);
});

test("ALL_PROXY is the fallback", () => {
  for (const key of PROXY_VARS) delete process.env[key];
  process.env.all_proxy = "http://127.0.0.1:2080";
  assert.notEqual(proxyDispatcher("https://example.com/"), undefined);
});

test("NO_PROXY excludes exact and subdomain matches", () => {
  for (const key of PROXY_VARS) delete process.env[key];
  process.env.HTTPS_PROXY = "http://127.0.0.1:2080";
  process.env.NO_PROXY = "localhost, .internal.test, googleapis.com";
  assert.equal(noProxyMatches("localhost"), true);
  assert.equal(noProxyMatches("foo.internal.test"), true);
  assert.equal(noProxyMatches("oauth2.googleapis.com"), true);
  assert.equal(noProxyMatches("evilgoogleapis.com"), false);
  assert.equal(proxyDispatcher("https://oauth2.googleapis.com/"), undefined);
  assert.notEqual(proxyDispatcher("https://example.com/"), undefined);
});

test("unsupported proxy protocol throws", () => {
  for (const key of PROXY_VARS) delete process.env[key];
  process.env.HTTPS_PROXY = "socks5://127.0.0.1:1080";
  assert.throws(() => proxyDispatcher("https://example.com/"), /only http\/https/);
});
