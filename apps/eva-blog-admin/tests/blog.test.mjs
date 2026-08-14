import test from "node:test";
import assert from "node:assert/strict";
import { ARTICLE_STATUSES, createSlug, listPublishedArticles, normalizeArticle } from "../src/domain/blog.js";
import { createLocalBlogApi } from "../src/services/localBlogApi.js";
import { createMemoryStorage } from "../src/services/storage.js";

test("normalizes article metadata and reading time", () => {
  const article = normalizeArticle({
    title: "Hello, Blog!",
    content: "This is a short article.",
    tags: "mvp, test",
    published: true
  }, { now: "2026-06-04T00:00:00.000Z" });

  assert.equal(article.slug, "hello-blog");
  assert.equal(article.status, ARTICLE_STATUSES.PUBLISHED);
  assert.deepEqual(article.tags, ["mvp", "test"]);
  assert.equal(article.readingMinutes, 1);
});

test("creates stable ascii slugs", () => {
  assert.equal(createSlug("  Café Notes + Work Log  "), "cafe-notes-work-log");
});

test("lists only published articles newest first", () => {
  const articles = [
    { id: "a", status: "draft", updatedAt: "2026-06-04T01:00:00.000Z" },
    { id: "b", status: "published", publishedAt: "2026-06-04T01:00:00.000Z" },
    { id: "c", status: "published", publishedAt: "2026-06-04T02:00:00.000Z" }
  ];

  assert.deepEqual(listPublishedArticles(articles).map((article) => article.id), ["c", "b"]);
});

test("local domain operations require an injected session for comments and status sync", async () => {
  const api = createLocalBlogApi({
    storage: createMemoryStorage(),
    seedData: {
      articles: [],
      comments: [],
      statuses: [],
      session: null
    },
    now: () => "2026-06-04T00:00:00.000Z"
  });

  const article = await api.saveArticle({
    title: "Published Post",
    content: "A test article that can receive comments.",
    publish: true
  });

  assert.throws(() => api.addComment(article.id, "Looks good."), /signed-in GitHub user/);
  const session = { provider: "github", id: "github-test", login: "eva-test", name: "Eva Test" };
  assert.throws(() => api.updateStatus({ title: "Working" }), /signed-in user/);

  const comment = api.addComment(article.id, "Looks good.", session);
  const status = api.updateStatus({ kind: "work", title: "Testing the MVP" }, session);
  const tokenStatus = api.updateStatus({ kind: "token", usedTokens: 128000, limitTokens: 256000, model: "gpt-5" }, session);

  assert.equal(comment.author.login, "eva-test");
  assert.equal(status.actor.login, "eva-test");
  assert.deepEqual(tokenStatus.meta, { usedTokens: 128000, limitTokens: 256000, unit: "tokens", model: "gpt-5" });
  assert.equal(api.getSnapshot().publicStatuses.length, 1);

  const automatic = api.updateStatus({ kind: "token", usagePercent: 42, usedTokens: 999999, limitTokens: 1000000, model: "private-model" }, session, { safeAuto: true });
  const automaticAgain = api.updateStatus({ kind: "token", usagePercent: 43, usedTokens: 1000000, limitTokens: 1000000, model: "private-model" }, session, { safeAuto: true });
  assert.deepEqual(automatic.meta, { usagePercent: 42, unit: "%" });
  assert.equal(automatic.isPublic, false);
  assert.deepEqual(automaticAgain.meta, { usagePercent: 43, unit: "%" });
  assert.equal(api.getSnapshot().statuses.filter((item) => item.syncKey === "auto:token").length, 1);
});

test("local API imports markdown as draft and publishes it to public readers", async () => {
  const api = createLocalBlogApi({
    storage: createMemoryStorage(),
    seedData: {
      articles: [],
      comments: [],
      statuses: [],
      session: null
    },
    now: () => "2026-06-04T00:00:00.000Z"
  });

  const draft = await api.importMarkdown("field-note.md", "# Field Note\n\nA publishable imported note.");
  assert.equal(draft.status, ARTICLE_STATUSES.DRAFT);
  assert.equal(api.getSnapshot().publishedArticles.length, 0);

  const published = await api.publish(draft.id);
  assert.equal(published.status, ARTICLE_STATUSES.PUBLISHED);
  assert.equal(published.summary.provider, "deterministic-fallback");
  assert.equal(api.getPublishedArticleBySlug("field-note").id, draft.id);
  assert.equal(api.getSnapshot().publishedArticles.length, 1);
});
