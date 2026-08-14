import test from "node:test";
import assert from "node:assert/strict";
import { createLocalBlogApi } from "../src/services/localBlogApi.js";
import { createMemoryStorage } from "../src/services/storage.js";

test("local author API keeps artwork lifecycle and article revisions private", async () => {
  const api = createLocalBlogApi({
    storage: createMemoryStorage({ articles: [], artworks: [], comments: [], revisions: [], statuses: [] }),
    now: () => "2026-08-12T12:00:00.000Z"
  });
  const draft = await api.saveArticle({ title: "Revision note", content: "First body" });
  await api.saveArticle({ id: draft.id, title: "Revision note", content: "Second body" });
  const revisions = api.getArticleRevisions(draft.id);
  assert.equal(revisions.length, 1);
  const restored = await api.restoreArticleRevision(draft.id, revisions[0].id);
  assert.equal(restored.content, "First body");

  const artwork = api.saveArtwork({ title: "Private plate", assets: [{ id: "asset_1", publicSrc: "/plate.webp", altText: "Plate" }] });
  assert.equal(artwork.status, "draft");
  const published = api.publishArtwork(artwork.id);
  assert.equal(api.getSnapshot().publishedArtworks[0].assets[0].src, "/plate.webp");
  assert.equal(published.status, "published");
});
