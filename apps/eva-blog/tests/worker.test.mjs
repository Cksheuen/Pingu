import test from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../server/worker.js";

test("worker lists published articles and returns article detail", async () => {
  const worker = createWorker({
    seedData: {
      articles: [
        {
          id: "article_1",
          title: "Worker Post",
          slug: "worker-post",
          content: "Worker route test.",
          tags: [],
          status: "published",
          publishedAt: "2026-06-04T00:00:00.000Z",
          updatedAt: "2026-06-04T00:00:00.000Z",
          readingMinutes: 1,
          excerpt: "Worker route test.",
          summary: null
        },
        {
          id: "article_draft",
          title: "Draft Worker Post",
          slug: "draft-worker-post",
          content: "Drafts should not be publicly readable.",
          tags: [],
          status: "draft",
          publishedAt: null,
          updatedAt: "2026-06-04T00:30:00.000Z",
          readingMinutes: 1,
          excerpt: "Drafts should not be publicly readable.",
          summary: null
        }
      ],
      comments: [],
      statuses: [],
      session: null
    }
  });

  const listResponse = await worker.fetch(new Request("https://example.test/api/articles"));
  const list = await listResponse.json();
  assert.equal(list.length, 1);

  const detailResponse = await worker.fetch(new Request("https://example.test/api/articles/worker-post"));
  const detail = await detailResponse.json();
  assert.equal(detail.title, "Worker Post");

  const draftResponse = await worker.fetch(new Request("https://example.test/api/articles/draft-worker-post"));
  assert.equal(draftResponse.status, 404);
});

test("worker rejects anonymous comments and accepts an injected GitHub session", async () => {
  const session = {
    provider: "github",
    id: "github-worker",
    login: "eva-worker",
    name: "Eva Worker",
    issuedAt: "2026-06-04T00:00:00.000Z"
  };
  const worker = createWorker({
    sessionResolver: () => null,
    seedData: {
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
      statuses: [],
      session: null
    }
  });

  const failed = await worker.fetch(new Request("https://example.test/api/articles/article_1/comments", {
    method: "POST",
    body: JSON.stringify({ body: "Before login" })
  }));
  assert.equal(failed.status, 401);

  const authenticatedWorker = createWorker({
    sessionResolver: () => session,
    seedData: {
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
    }
  });

  const created = await authenticatedWorker.fetch(new Request("https://example.test/api/articles/article_1/comments", {
    method: "POST",
    body: JSON.stringify({ body: "After login" })
  }));
  assert.equal(created.status, 201);
  const comment = await created.json();
  assert.equal(comment.author.login, "eva-worker");
});

test("public worker does not expose session state or mock-session writes", async () => {
  const worker = createWorker({ sessionResolver: () => null });
  const response = await worker.fetch(new Request("https://example.test/api/session"));
  assert.equal(response.status, 404);
  const mockRoute = await worker.fetch(new Request("https://example.test/api/session/mock", { method: "POST" }));
  assert.equal(mockRoute.status, 404);
});

test("public worker does not expose author write routes", async () => {
  const worker = createWorker({
    seedData: { articles: [], comments: [], statuses: [], session: null }
  });

  const saveResponse = await worker.fetch(new Request("https://example.test/api/articles", {
    method: "POST",
    body: JSON.stringify({ title: "Should stay private", content: "No public author route." })
  }));
  const statusResponse = await worker.fetch(new Request("https://example.test/api/status", {
    method: "POST",
    body: JSON.stringify({ title: "Should stay private" })
  }));

  assert.equal(saveResponse.status, 404);
  assert.equal(statusResponse.status, 404);
  const automaticStatusResponse = await worker.fetch(new Request("https://example.test/api/status/auto", {
    method: "POST",
    body: JSON.stringify({ kind: "token", usagePercent: 42 })
  }));
  assert.equal(automaticStatusResponse.status, 404);
});
