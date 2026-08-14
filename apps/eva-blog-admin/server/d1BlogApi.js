import { createLocalBlogApi } from "../src/services/localBlogApi.js";
import { createMemoryStorage } from "../src/services/storage.js";

const STATE_ID = "primary";

export function createD1BlogApi({ db, seedData, summaryProvider, now } = {}) {
  if (!db) throw new Error("createD1BlogApi requires a D1 binding.");

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
    const api = createLocalBlogApi({ storage: memory, seedData, summaryProvider, now });
    const result = await action(api);
    if (write) await writeState(memory.read());
    return result;
  }

  return {
    addComment: (articleId, body, session) => withApi((api) => api.addComment(articleId, body, session), { write: true }),
    getArticleBySlug: (slug) => withApi((api) => api.getArticleBySlug(slug)),
    getPublishedArticleBySlug: (slug) => withApi((api) => api.getPublishedArticleBySlug(slug)),
    getCommentsForArticle: (articleId) => withApi((api) => api.getCommentsForArticle(articleId)),
    getRecentActivitySummary: () => withApi((api) => api.getRecentActivitySummary()),
    getSnapshot: () => withApi((api) => api.getSnapshot()),
    importMarkdown: (filename, markdown) => withApi((api) => api.importMarkdown(filename, markdown), { write: true }),
    publish: (id) => withApi((api) => api.publish(id), { write: true }),
    unpublish: (id) => withApi((api) => api.unpublish(id), { write: true }),
    getArticleRevisions: (articleId) => withApi((api) => api.getArticleRevisions(articleId)),
    restoreArticleRevision: (articleId, revisionId) => withApi((api) => api.restoreArticleRevision(articleId, revisionId), { write: true }),
    saveArtwork: (input) => withApi((api) => api.saveArtwork(input), { write: true }),
    publishArtwork: (id) => withApi((api) => api.publishArtwork(id), { write: true }),
    unpublishArtwork: (id) => withApi((api) => api.unpublishArtwork(id), { write: true }),
    getArtworkBySlug: (slug) => withApi((api) => api.getArtworkBySlug(slug)),
    queryPublishedArticles: (query) => withApi((api) => api.queryPublishedArticles(query)),
    resetDemoData: () => withApi((api) => api.resetDemoData(), { write: true }),
    saveArticle: (input) => withApi((api) => api.saveArticle(input), { write: true }),
    updateStatus: (input, session, options) => withApi((api) => api.updateStatus(input, session, options), { write: true })
  };
}
