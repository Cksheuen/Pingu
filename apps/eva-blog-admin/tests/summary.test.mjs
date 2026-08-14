import test from "node:test";
import assert from "node:assert/strict";
import { createDeterministicSummaryProvider, summarizeActivity, summarizeArticle } from "../src/services/summaryService.js";

test("deterministic article summary is stable", async () => {
  const provider = createDeterministicSummaryProvider();
  const article = {
    title: "A summary test",
    content: "This article explains the MVP summary fallback. It should be deterministic.",
    tags: ["summary"],
    updatedAt: "2026-06-04T00:00:00.000Z"
  };

  const first = await summarizeArticle(article, provider);
  const second = await summarizeArticle(article, provider);

  assert.deepEqual(first, second);
  assert.match(first.text, /Estimated reading time/);
  assert.equal(first.provider, "deterministic-fallback");
});

test("activity summary combines status and latest published article", async () => {
  const summary = await summarizeActivity({
    statuses: [{
      kind: "song",
      title: "An ambient track",
      details: "for writing",
      isPublic: true,
      updatedAt: "2026-06-04T02:00:00.000Z"
    }],
    articles: [{
      title: "Latest public note",
      status: "published",
      publishedAt: "2026-06-04T01:00:00.000Z"
    }]
  });

  assert.match(summary.text, /Listening: An ambient track/);
  assert.match(summary.text, /Latest article: Latest public note/);
});
