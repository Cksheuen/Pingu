import {
  ensureUniqueSlug,
  findArticleBySlug,
  listAllArticles,
  listPublishedArticles,
  matchesArticleQuery,
  normalizeArticle,
  parseMarkdownArticle,
  publishArticle,
  unpublishArticle
} from "../domain/blog.js";
import { artworkToPublic, findArtworkBySlug, listPublishedArtworks, normalizeArtwork, publishArtwork, unpublishArtwork } from "../domain/artwork.js";
import { createComment, listCommentsForArticle } from "../domain/comments.js";
import { listPublicStatuses, normalizeStatus } from "../domain/status.js";
import { createDeterministicSummaryProvider, summarizeActivity, summarizeArticle } from "./summaryService.js";

const EMPTY_STATE = Object.freeze({
  articles: [],
  artworks: [],
  comments: [],
  revisions: [],
  statuses: [],
  session: null
});

export function createLocalBlogApi({ storage, seedData = EMPTY_STATE, summaryProvider = createDeterministicSummaryProvider(), now = () => new Date().toISOString() }) {
  if (!storage) {
    throw new Error("createLocalBlogApi requires a storage adapter.");
  }

  function readState() {
    return normalizeState(storage.read() || seedData);
  }

  function writeState(state) {
    storage.write(normalizeState(state));
  }

  async function saveArticle(input) {
    const state = readState();
    const current = input.id ? state.articles.find((article) => article.id === input.id) : null;
    const normalized = normalizeArticle({
      ...current,
      ...input,
      status: input.publish ? "published" : input.status || current?.status
    }, { now: now() });
    normalized.slug = ensureUniqueSlug(normalized.slug, state.articles, normalized.id);
    normalized.summary = await summarizeArticle(normalized, summaryProvider);

    const revisions = current && (current.title !== normalized.title || current.content !== normalized.content)
      ? [{ ...createRevision(current, { now: now(), label: "Before latest save" }), id: undefined }, ...state.revisions]
      : state.revisions;

    const articles = current
      ? state.articles.map((article) => article.id === normalized.id ? normalized : article)
      : [normalized, ...state.articles];

    writeState({ ...state, articles, revisions: revisions.map((revision) => revision.id ? revision : { ...revision, id: createRevisionId() }) });
    return normalized;
  }

  async function publish(id) {
    const state = readState();
    const article = state.articles.find((item) => item.id === id);
    if (!article) {
      throw new Error("Article not found.");
    }
    const published = publishArticle(article, { now: now() });
    published.summary = await summarizeArticle(published, summaryProvider);
    writeState({
      ...state,
      articles: state.articles.map((item) => item.id === id ? published : item)
    });
    return published;
  }

  function unpublish(id) {
    const state = readState();
    const article = state.articles.find((item) => item.id === id);
    if (!article) throw new Error("Article not found.");
    const unpublished = unpublishArticle(article, { now: now() });
    writeState({ ...state, articles: state.articles.map((item) => item.id === id ? unpublished : item) });
    return unpublished;
  }

  function getArticleRevisions(articleId) {
    return readState().revisions.filter((revision) => revision.articleId === articleId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async function restoreArticleRevision(articleId, revisionId) {
    const state = readState();
    const article = state.articles.find((item) => item.id === articleId);
    const revision = state.revisions.find((item) => item.id === revisionId && item.articleId === articleId);
    if (!article || !revision) throw new Error("Article revision not found.");
    const restored = restoreRevision(article, revision, { now: now() });
    restored.summary = await summarizeArticle(restored, summaryProvider);
    writeState({ ...state, articles: state.articles.map((item) => item.id === articleId ? restored : item) });
    return restored;
  }

  function saveArtwork(input) {
    const state = readState();
    const current = input.id ? state.artworks.find((artwork) => artwork.id === input.id) : null;
    const normalized = normalizeArtwork({ ...current, ...input }, { now: now() });
    normalized.slug = ensureUniqueArtworkSlug(normalized.slug, state.artworks, normalized.id);
    const artworks = current
      ? state.artworks.map((artwork) => artwork.id === normalized.id ? normalized : artwork)
      : [normalized, ...state.artworks];
    writeState({ ...state, artworks });
    return normalized;
  }

  function publishArtworkById(id) {
    const state = readState();
    const artwork = state.artworks.find((item) => item.id === id);
    if (!artwork) throw new Error("Artwork not found.");
    const published = publishArtwork(artwork, { now: now() });
    writeState({ ...state, artworks: state.artworks.map((item) => item.id === id ? published : item) });
    return published;
  }

  function unpublishArtworkById(id) {
    const state = readState();
    const artwork = state.artworks.find((item) => item.id === id);
    if (!artwork) throw new Error("Artwork not found.");
    const unpublished = unpublishArtwork(artwork, { now: now() });
    writeState({ ...state, artworks: state.artworks.map((item) => item.id === id ? unpublished : item) });
    return unpublished;
  }

  async function importMarkdown(filename, markdown) {
    const article = parseMarkdownArticle(filename, markdown, { now: now() });
    return saveArticle(article);
  }

  function addComment(articleId, body, session) {
    const state = readState();
    const article = state.articles.find((item) => item.id === articleId);
    if (!article || article.status !== "published") {
      throw new Error("Comments are only available for published articles.");
    }
    const comment = createComment({ articleId, body, session }, { now: now() });
    writeState({ ...state, comments: [...state.comments, comment] });
    return comment;
  }

  function updateStatus(input, session, options = {}) {
    const state = readState();
    const status = normalizeStatus(input, session, { now: now(), ...options });
    const statuses = status.syncKey && state.statuses.some((item) => item.syncKey === status.syncKey)
      ? state.statuses.map((item) => item.syncKey === status.syncKey ? { ...status, id: item.id, createdAt: item.createdAt } : item)
      : [status, ...state.statuses];
    writeState({ ...state, statuses });
    return status;
  }

  async function getRecentActivitySummary() {
    const state = readState();
    return summarizeActivity(state, summaryProvider);
  }

  function resetDemoData() {
    storage.clear();
    writeState(seedData);
    return getSnapshot();
  }

  function getSnapshot() {
    const state = readState();
    return {
      ...state,
      articles: listAllArticles(state.articles),
      publishedArticles: listPublishedArticles(state.articles),
      artworks: [...state.artworks].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
      publishedArtworks: listPublishedArtworks(state.artworks).map((artwork) => artworkToPublic(artwork)),
      revisions: state.revisions,
      publicStatuses: listPublicStatuses(state.statuses),
      session: state.session
    };
  }

  function queryPublishedArticles(query) {
    return listPublishedArticles(readState().articles).filter((article) => matchesArticleQuery(article, query));
  }

  return {
    addComment,
    getArticleBySlug(slug) {
      return findArticleBySlug(readState().articles, slug);
    },
    getPublishedArticleBySlug(slug) {
      return findArticleBySlug(listPublishedArticles(readState().articles), slug);
    },
    getCommentsForArticle(articleId) {
      return listCommentsForArticle(readState().comments, articleId);
    },
    getRecentActivitySummary,
    getSnapshot,
    importMarkdown,
    publish,
    unpublish,
    getArticleRevisions,
    restoreArticleRevision,
    saveArtwork,
    publishArtwork: publishArtworkById,
    unpublishArtwork: unpublishArtworkById,
    getArtworkBySlug(slug) {
      return findArtworkBySlug(readState().artworks, slug);
    },
    queryPublishedArticles,
    resetDemoData,
    saveArticle,
    updateStatus
  };
}

function normalizeState(state) {
  return {
    articles: Array.isArray(state.articles) ? state.articles : [],
    artworks: Array.isArray(state.artworks) ? state.artworks : [],
    comments: Array.isArray(state.comments) ? state.comments : [],
    revisions: Array.isArray(state.revisions) ? state.revisions : [],
    statuses: Array.isArray(state.statuses) ? state.statuses : [],
    session: state.session || null
  };
}

function createRevision(article, options = {}) {
  return {
    id: options.id || createRevisionId(),
    articleId: article.id,
    title: article.title,
    content: article.content,
    slug: article.slug,
    tags: [...(article.tags || [])],
    series: article.series || null,
    relatedSlugs: [...(article.relatedSlugs || [])],
    cover: article.cover || null,
    seoDescription: article.seoDescription || "",
    status: article.status,
    scheduledAt: article.scheduledAt || null,
    createdAt: options.now || new Date().toISOString(),
    label: options.label || "Saved revision"
  };
}

function restoreRevision(article, revision, options = {}) {
  return normalizeArticle({ ...article, ...revision, id: article.id, status: article.status, publishedAt: article.publishedAt, createdAt: article.createdAt }, { now: options.now });
}

function ensureUniqueArtworkSlug(slug, artworks, currentId) {
  const taken = new Set(artworks.filter((artwork) => artwork.id !== currentId).map((artwork) => artwork.slug));
  if (!taken.has(slug)) return slug;
  let index = 2;
  let candidate = `${slug}-${index}`;
  while (taken.has(candidate)) candidate = `${slug}-${++index}`;
  return candidate;
}

function createRevisionId() {
  const randomPart = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  return `revision_${randomPart}`;
}
