import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubOAuth } from "../server/auth";
import { readSignedSessionCookie } from "../src/services/sessionCookie";

test("GitHub OAuth uses state, rejects open redirects, and sets a signed HTTP-only session", async () => {
  const calls: Array<{ url: string | URL | Request; options?: RequestInit }> = [];
  const oauth = createGitHubOAuth({
    env: {
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      SESSION_SECRET: "session-secret",
      ALLOWED_REDIRECT_ORIGINS: "https://status.example"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "access-token" }));
      return new Response(JSON.stringify({ id: 42, login: "eva-author", name: "Eva Author", avatar_url: "https://github.com/eva-author.png" }));
    },
    now: () => "2026-08-12T00:00:00.000Z"
  });

  const start = await oauth.start(new Request("https://author.example/api/auth/github/start?redirect=https%3A%2F%2Fevil.example%2Fsteal"));
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get("Location")!);
  assert.equal(location.origin, "https://github.com");
  assert.ok(location.searchParams.get("state"));

  const callback = await oauth.callback(new Request(`https://author.example/api/auth/github/callback?code=oauth-code&state=${encodeURIComponent(location.searchParams.get("state")!)}`));
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("Location"), "https://author.example/");
  assert.match(callback.headers.get("Set-Cookie")!, /HttpOnly/);
  assert.match(callback.headers.get("Set-Cookie")!, /SameSite=Lax/);
  assert.equal(calls.length, 2);

  const cookie = callback.headers.get("Set-Cookie")!.split(";")[0].split("=")[1];
  const session = await readSignedSessionCookie(cookie, "session-secret");
  assert.ok(session, "签名 cookie 应解析出会话");
  assert.equal(session.login, "eva-author");
  assert.equal(session.provider, "github");
});

test("GitHub OAuth fails closed when credentials are not configured", async () => {
  const oauth = createGitHubOAuth({ env: {} });
  const response = await oauth.start(new Request("https://author.example/api/auth/github/start"));
  assert.equal(response.status, 503);
});
