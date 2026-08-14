import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubOAuth } from "../server/auth.js";
import { readSignedSessionCookie } from "../src/services/sessionCookie.js";

test("private author OAuth exchanges GitHub identity for a signed session", async () => {
  const oauth = createGitHubOAuth({
    env: {
      GITHUB_CLIENT_ID: "author-client",
      GITHUB_CLIENT_SECRET: "author-secret",
      SESSION_SECRET: "author-session-secret"
    },
    fetchImpl: async (url) => url.includes("access_token")
      ? new Response(JSON.stringify({ access_token: "github-token" }))
      : new Response(JSON.stringify({ id: 7, login: "eva-author", name: "Eva Author", avatar_url: "https://github.com/eva-author.png" })),
    now: () => "2026-08-12T00:00:00.000Z"
  });

  const start = await oauth.start(new Request("https://author.example/api/auth/github/start?redirect=%2F"));
  const githubUrl = new URL(start.headers.get("Location"));
  const callback = await oauth.callback(new Request(`https://author.example/api/auth/github/callback?code=code&state=${githubUrl.searchParams.get("state")}`));
  assert.equal(callback.status, 302);
  const cookie = callback.headers.get("Set-Cookie").split(";")[0].split("=")[1];
  const session = await readSignedSessionCookie(cookie, "author-session-secret");
  assert.equal(session.login, "eva-author");
  assert.equal(session.provider, "github");
});
