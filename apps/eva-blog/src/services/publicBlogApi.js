import { findArticleBySlug, getArticleOutline, getRelatedArticles, listArticleArchives, listArticleSeries, listArticleTags, listPublishedArticles, matchesArticleQuery } from "../domain/publicBlog.js";
import { artworkToPublic, findArtworkBySlug, listPublishedArtworks } from "../domain/publicArtwork.js";
import { createComment, listCommentsForArticle } from "../domain/comments.js";
import { listPublicStatuses } from "../domain/publicStatus.js";

const EMPTY_STATE = Object.freeze({
  articles: [],
  artworks: [],
  comments: [],
  statuses: []
});

export function createPublicBlogApi({ storage, seedData = EMPTY_STATE, now = () => new Date().toISOString() }) {
  if (!storage) {
    throw new Error("createPublicBlogApi requires a storage adapter.");
  }

  function readState() {
    return normalizeState(storage.read() || seedData);
  }

  function writeState(state) {
    storage.write(normalizeState(state));
  }

  function getSnapshot() {
    const state = readState();
    return {
      publishedArticles: listPublishedArticles(state.articles).map(toPublicArticle),
      archives: listArticleArchives(state.articles).map((group) => ({ ...group, entries: group.entries.map(toPublicArticle) })),
      tags: listArticleTags(state.articles),
      series: listArticleSeries(state.articles).map((series) => ({ ...series, entries: series.entries.map(toPublicArticle) })),
      publishedArtworks: listPublishedArtworks(state.artworks).map((artwork) => artworkToPublic(artwork)),
      publicStatuses: listPublicStatuses(state.statuses)
    };
  }

  return {
    addComment(articleId, body, session) {
      const state = readState();
      const article = state.articles.find((item) => item.id === articleId);
      if (!article || article.status !== "published") {
        throw new Error("Comments are only available for published articles.");
      }
      const comment = createComment({ articleId, body, session }, { now: now() });
      writeState({ ...state, comments: [...state.comments, comment] });
      return comment;
    },
    getCommentsForArticle(articleId) {
      return listCommentsForArticle(readState().comments, articleId);
    },
    getPublishedArticleBySlug(slug) {
      const article = findArticleBySlug(listPublishedArticles(readState().articles), slug);
      return article ? toPublicArticle(article) : null;
    },
    getArticleReaderPayload(slug) {
      const state = readState();
      const articles = listPublishedArticles(state.articles);
      const article = findArticleBySlug(articles, slug);
      if (!article) return null;
      const publicArticle = toPublicArticle(article);
      return { ...publicArticle, outline: getArticleOutline(publicArticle.content), related: getRelatedArticles(publicArticle, articles).map(toPublicArticle) };
    },
    getPublishedArtworks() {
      return listPublishedArtworks(readState().artworks).map((artwork) => artworkToPublic(artwork));
    },
    getPublishedArtworkBySlug(slug) {
      const artwork = findArtworkBySlug(listPublishedArtworks(readState().artworks), slug);
      return artwork ? artworkToPublic(artwork) : null;
    },
    getPublishedArtworkAsset(slug, assetId, variant = "display") {
      const artwork = findArtworkBySlug(listPublishedArtworks(readState().artworks), slug);
      const asset = artwork?.assets?.find((item) => item.id === assetId);
      if (!asset) return null;
      return { key: variant === "thumb" ? asset.thumbKey : asset.displayKey, mimeType: asset.mimeType || "image/webp" };
    },
    getSnapshot,
    queryPublishedArticles(query) {
      return listPublishedArticles(readState().articles).filter((article) => matchesArticleQuery(article, query)).map(toPublicArticle);
    }
  };
}

function toPublicArticle(article) {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    content: article.content,
    tags: article.tags || [],
    status: "published",
    publishedAt: article.publishedAt || article.scheduledAt || article.updatedAt,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    excerpt: article.excerpt || "",
    readingMinutes: article.readingMinutes || 1,
    summary: article.summary || null,
    series: article.series || null,
    relatedSlugs: article.relatedSlugs || [],
    cover: article.cover ? {
      src: article.cover.src || "",
      alt: article.cover.alt || "",
      focalPoint: article.cover.focalPoint || "center"
    } : null,
    seoDescription: article.seoDescription || article.excerpt || ""
  };
}

function normalizeState(state) {
  return {
    articles: Array.isArray(state.articles) ? state.articles : [],
    artworks: Array.isArray(state.artworks) ? state.artworks : [],
    comments: Array.isArray(state.comments) ? state.comments : [],
    statuses: Array.isArray(state.statuses) ? state.statuses : []
  };
}
