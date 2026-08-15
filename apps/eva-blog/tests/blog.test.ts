import test from "node:test";
import assert from "node:assert/strict";
import { findArticleBySlug, listPublishedArticles, matchesArticleQuery } from "../src/domain/publicBlog";
import { describeStatus } from "../src/domain/publicStatus";
import { createPublicBlogApi } from "../src/services/publicBlogApi";
import { createMemoryStorage } from "../src/services/storage";
import type { Session } from "../src/types";

const publishedArticle = {
  id: "article_public",
  title: "Public Post",
  slug: "public-post",
  content: "A public article that can receive comments.",
  excerpt: "A public article that can receive comments.",
  tags: ["reader"],
  status: "published",
  publishedAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
  readingMinutes: 1,
  summary: { provider: "deterministic-fallback", text: "A public summary." }
};

test("public article queries expose published articles only", () => {
  const articles = [
    { id: "draft", status: "draft", updatedAt: "2026-06-04T03:00:00.000Z" },
    { id: "older", status: "published", publishedAt: "2026-06-04T01:00:00.000Z" },
    { id: "newer", status: "published", publishedAt: "2026-06-04T02:00:00.000Z" }
  ];

  assert.deepEqual(listPublishedArticles(articles).map((article) => article.id), ["newer", "older"]);
  assert.equal(findArticleBySlug([{ slug: "public-post" }], "public-post")!.slug, "public-post");
  assert.equal(matchesArticleQuery({ title: "Eva Notes", excerpt: "", content: "", tags: [] }, "eva"), true);
});

test("public status descriptions include music and token signals", () => {
  assert.equal(describeStatus({ kind: "song", title: "Night Drive", meta: { track: "Night Drive", artist: "Eva FM" } }), "Listening: Night Drive · Eva FM");
  assert.equal(describeStatus({ kind: "token", title: "Token usage", meta: { usedTokens: 128000, limitTokens: 256000 } }), "Token usage: 128K / 256K tokens");
  assert.equal(describeStatus({ kind: "token", title: "Token usage", meta: { usagePercent: 42, unit: "%" } }), "Token usage: 42%");
});

test("public API requires an injected authenticated session for comments", () => {
  const api = createPublicBlogApi({
    storage: createMemoryStorage({ articles: [publishedArticle], comments: [], statuses: [], session: null }),
    now: () => "2026-06-04T00:00:00.000Z"
  });

  assert.throws(() => api.addComment(publishedArticle.id, "Before login", null as unknown as Session), /signed-in GitHub user/);
  // 会话夹具带 issuedAt（cookie 层字段），提取为常量以避开对象字面量的多余属性检查
  const readerSession = {
    provider: "github",
    id: "github-reader",
    login: "eva-reader",
    name: "Eva Reader",
    issuedAt: "2026-06-04T00:00:00.000Z"
  };
  const comment = api.addComment(publishedArticle.id, "Looks good.", readerSession);

  assert.equal(comment.author.login, "eva-reader");
  assert.equal(api.getPublishedArticleBySlug("public-post")!.id, publishedArticle.id);
  assert.equal(api.getSnapshot().publishedArticles.length, 1);
  // PublicBlogApi 不暴露作者端方法，用宽松访问保持断言语义
  assert.equal(typeof (api as unknown as Record<string, unknown>).saveArticle, "undefined");
  assert.equal(typeof (api as unknown as Record<string, unknown>).updateStatus, "undefined");
  assert.equal(typeof (api as unknown as Record<string, unknown>).loginMock, "undefined");
});
