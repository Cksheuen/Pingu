import test from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../server/worker.js";

const seedData = {
  articles: [{
    id: "article_public",
    title: "A public note",
    slug: "a-public-note",
    content: "# A public note\n\n## A section\n\nReader-safe text.",
    tags: ["systems"],
    series: { title: "Small systems", slug: "small-systems", order: 1 },
    status: "published",
    publishedAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    excerpt: "Reader-safe text.",
    summary: { provider: "test", text: "Safe summary." }
  }],
  artworks: [{
    id: "artwork_public",
    title: "Safe plate",
    slug: "safe-plate",
    status: "published",
    publishedAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    altText: "A safe public plate",
    assets: [{ id: "asset_public", originalKey: "private/original", displayKey: "public/display", thumbKey: "public/thumb", publicSrc: "/plate.webp", altText: "A safe public plate", width: 900, height: 600 }]
  }],
  comments: [],
  statuses: []
};

test("public module routes expose archive, reader payload, artwork, and distribution metadata", async () => {
  const worker = createWorker({ seedData });
  const articleResponse = await worker.fetch(new Request("https://blog.test/api/articles/a-public-note"));
  const article = await articleResponse.json();
  assert.deepEqual(article.outline.map((item) => item.text), ["A section"]);
  assert.equal(article.related.length, 0);

  const artworkResponse = await worker.fetch(new Request("https://blog.test/api/artworks/safe-plate"));
  const artwork = await artworkResponse.json();
  assert.equal(artwork.assets[0].src, "/plate.webp");
  assert.equal("originalKey" in artwork.assets[0], false);

  for (const path of ["/api/archives", "/api/tags", "/api/series", "/feed.xml", "/sitemap.xml"]) {
    const response = await worker.fetch(new Request(`https://blog.test${path}`));
    assert.equal(response.status, 200, path);
  }
});
