import { createMemoryStorage } from "./storage.js";
import { createPublicBlogApi } from "./publicBlogApi.js";

const STATE_ID = "primary";

export function createD1PublicBlogApi({ db, seedData, now } = {}) {
  if (!db) throw new Error("createD1PublicBlogApi requires a D1 binding.");

  async function readState() {
    const row = await db.prepare("SELECT payload FROM blog_state WHERE state_id = ?1").bind(STATE_ID).first();
    return row?.payload ? JSON.parse(row.payload) : null;
  }

  async function writeState(state) {
    await db.prepare("INSERT INTO blog_state (state_id, payload, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(state_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .bind(STATE_ID, JSON.stringify(state), new Date().toISOString())
      .run();
  }

  async function withApi(action, { write = false } = {}) {
    const memory = createMemoryStorage((await readState()) || seedData);
    const api = createPublicBlogApi({ storage: memory, seedData, now });
    const result = await action(api);
    if (write) await writeState(memory.read());
    return result;
  }

  return {
    addComment: (articleId, body, session) => withApi((api) => api.addComment(articleId, body, session), { write: true }),
    getCommentsForArticle: (articleId) => withApi((api) => api.getCommentsForArticle(articleId)),
    getPublishedArticleBySlug: (slug) => withApi((api) => api.getPublishedArticleBySlug(slug)),
    getArticleReaderPayload: (slug) => withApi((api) => api.getArticleReaderPayload(slug)),
    getPublishedArtworks: () => withApi((api) => api.getPublishedArtworks()),
    getPublishedArtworkBySlug: (slug) => withApi((api) => api.getPublishedArtworkBySlug(slug)),
    getPublishedArtworkAsset: (slug, assetId, variant) => withApi((api) => api.getPublishedArtworkAsset(slug, assetId, variant)),
    getSnapshot: () => withApi((api) => api.getSnapshot()),
    queryPublishedArticles: (query) => withApi((api) => api.queryPublishedArticles(query))
  };
}
