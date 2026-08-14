import test from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../server/worker.js";
import { createSignedSessionCookie } from "../src/services/sessionCookie.js";

const session = {
  provider: "github",
  id: "github-worker",
  login: "eva-worker",
  name: "Eva Worker",
  issuedAt: "2026-06-04T00:00:00.000Z"
};

const seedData = {
  articles: [{
    id: "article_1",
    title: "Commentable",
    slug: "commentable",
    content: "Comment route test.",
    tags: [],
    status: "published",
    publishedAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    readingMinutes: 1,
    excerpt: "Comment route test.",
    summary: null
  }],
  comments: [],
  statuses: []
};

test("author worker exposes article inventory", async () => {
  const worker = createWorker({ seedData, sessionResolver: () => session, authorLogins: ["eva-worker"] });
  const response = await worker.fetch(new Request("https://example.test/api/articles"));
  const articles = await response.json();
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "Commentable");
});

test("author worker rejects anonymous writes and accepts an allowlisted GitHub author", async () => {
  const anonymous = createWorker({ seedData, sessionResolver: () => null, authorLogins: ["eva-worker"] });
  const failed = await anonymous.fetch(new Request("https://example.test/api/status", {
    method: "POST",
    body: JSON.stringify({ kind: "work", title: "Before login" })
  }));
  assert.equal(failed.status, 401);
  const automaticFailed = await anonymous.fetch(new Request("https://example.test/api/status/auto", {
    method: "POST",
    body: JSON.stringify({ kind: "token", usagePercent: 42 })
  }));
  assert.equal(automaticFailed.status, 401);

  const worker = createWorker({ seedData, sessionResolver: () => session, authorLogins: ["eva-worker"] });
  const statusResponse = await worker.fetch(new Request("https://example.test/api/status", {
    method: "POST",
    body: JSON.stringify({ kind: "work", title: "After login" })
  }));
  assert.equal(statusResponse.status, 201);
  const status = await statusResponse.json();
  assert.equal(status.actor.login, "eva-worker");

  const automaticResponse = await worker.fetch(new Request("https://example.test/api/status/auto", {
    method: "POST",
    body: JSON.stringify({ kind: "token", usagePercent: 42, usedTokens: 999999, limitTokens: 1000000, model: "private-model", details: "must be dropped" })
  }));
  assert.equal(automaticResponse.status, 201);
  const automaticStatus = await automaticResponse.json();
  assert.deepEqual(automaticStatus.meta, { usagePercent: 42, unit: "%" });
  assert.equal(automaticStatus.isPublic, false);
  assert.equal(automaticStatus.details, "");

  const nestedAutomaticResponse = await worker.fetch(new Request("https://example.test/api/status/auto", {
    method: "POST",
    body: JSON.stringify({
      kind: "token",
      title: "ignored",
      details: "must be dropped",
      meta: { usagePercent: 57, unit: "tokens", usedTokens: 999999 }
    })
  }));
  assert.equal(nestedAutomaticResponse.status, 201);
  const nestedAutomaticStatus = await nestedAutomaticResponse.json();
  assert.deepEqual(nestedAutomaticStatus.meta, { usagePercent: 57, unit: "%" });
  assert.equal(nestedAutomaticStatus.details, "");

  const automaticMusicResponse = await worker.fetch(new Request("https://example.test/api/status/auto", {
    method: "POST",
    body: JSON.stringify({ kind: "song", track: "Night Drive", artist: "Eva FM", service: "Spotify", album: "private-album", url: "https://private.example", artworkUrl: "https://private.example/art", details: "must be dropped" })
  }));
  assert.equal(automaticMusicResponse.status, 201);
  const automaticMusic = await automaticMusicResponse.json();
  assert.deepEqual(automaticMusic.meta, { track: "Night Drive", artist: "Eva FM", service: "Spotify", playing: true });
  assert.equal(automaticMusic.isPublic, false);
  assert.equal(automaticMusic.details, "");

  const tokenResponse = await worker.fetch(new Request("https://example.test/api/status", {
    method: "POST",
    body: JSON.stringify({ kind: "token", usedTokens: 128000, limitTokens: 256000, model: "gpt-5" })
  }));
  assert.equal(tokenResponse.status, 201);
  assert.deepEqual((await tokenResponse.json()).meta, { usedTokens: 128000, limitTokens: 256000, unit: "tokens", model: "gpt-5" });

  const commentResponse = await worker.fetch(new Request("https://example.test/api/articles/article_1/comments", {
    method: "POST",
    body: JSON.stringify({ body: "After login" })
  }));
  assert.equal(commentResponse.status, 201);
  assert.equal((await commentResponse.json()).author.login, "eva-worker");
});

test("author worker does not expose a mock session route", async () => {
  const worker = createWorker({ sessionResolver: () => null });
  const response = await worker.fetch(new Request("https://example.test/api/session/mock", { method: "POST" }));
  assert.equal(response.status, 404);
});

test("author worker recognizes the signed HTTP-only session cookie", async () => {
  const cookie = await createSignedSessionCookie(session, "session-secret");
  const worker = createWorker({ env: { SESSION_SECRET: "session-secret" }, authorLogins: ["eva-worker"] });
  const response = await worker.fetch(new Request("https://example.test/api/session", { headers: { Cookie: `eva_session=${cookie}` } }));
  assert.deepEqual(await response.json(), {
    authenticated: true,
    author: true,
    user: {
      provider: "github",
      id: "github-worker",
      login: "eva-worker",
      name: "Eva Worker",
      avatarUrl: "",
      issuedAt: "2026-06-04T00:00:00.000Z"
    }
  });
});

test("author worker issues a scoped daemon token and accepts it for safe auto sync", async () => {
  const secret = "daemon-session-secret";
  const cookie = await createSignedSessionCookie(session, secret);
  const worker = createWorker({ env: { SESSION_SECRET: secret }, authorLogins: ["eva-worker"] });
  const issuedResponse = await worker.fetch(new Request("https://example.test/api/status/daemon-token", {
    method: "POST",
    headers: { Cookie: `eva_session=${cookie}` }
  }));
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json();
  assert.equal(issued.scope, "status:auto");
  assert.equal(issued.session.login, "eva-worker");
  assert.ok(issued.token);

  const autoResponse = await worker.fetch(new Request("https://example.test/api/status/auto", {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ kind: "token", usagePercent: 31, details: "discarded" })
  }));
  assert.equal(autoResponse.status, 201);
  const status = await autoResponse.json();
  assert.equal(status.actor.login, "eva-worker");
  assert.deepEqual(status.meta, { usagePercent: 31, unit: "%" });
  assert.equal(status.isPublic, false);

  const articlesResponse = await worker.fetch(new Request("https://example.test/api/articles", {
    headers: { Authorization: `Bearer ${issued.token}` }
  }));
  assert.equal(articlesResponse.status, 401);
});
