import { findArticleBySlug, getArticleOutline, getRelatedArticles, listArticleArchives, listArticleSeries, listArticleTags, listPublishedArticles, matchesArticleQuery } from "../domain/publicBlog";
import { artworkToPublic, findArtworkBySlug, listPublishedArtworks } from "../domain/publicArtwork";
import { createComment, listCommentsForArticle } from "../domain/comments";
import { listPublicStatuses } from "../domain/publicStatus";
import type { Article, BlogState, Comment, PublicArticle, PublicArtwork, PublicStatus, Session, StorageAdapter } from "../types";

const EMPTY_STATE: BlogState = Object.freeze({
  articles: [],
  artworks: [],
  comments: [],
  statuses: []
});

export interface PublicBlogApi {
  addComment(articleId: string, body: string, session: Session): Comment;
  getCommentsForArticle(articleId: string): Comment[];
  getPublishedArticleBySlug(slug: string): PublicArticle | null;
  getArticleReaderPayload(slug: string): (PublicArticle & { outline: ReturnType<typeof getArticleOutline>; related: PublicArticle[] }) | null;
  getPublishedArtworks(): PublicArtwork[];
  getPublishedArtworkBySlug(slug: string): PublicArtwork | null;
  getPublishedArtworkAsset(slug: string, assetId: string, variant?: string): { key: string | undefined; mimeType: string } | null;
  getSnapshot(): BlogSnapshot;
  queryPublishedArticles(query: string): PublicArticle[];
}

export interface BlogSnapshot {
  publishedArticles: PublicArticle[];
  archives: Array<{ year: string; entries: PublicArticle[] }>;
  tags: Array<{ tag: string; count: number; slug: string }>;
  series: Array<{ title: string; slug: string; order?: number; entries: PublicArticle[] }>;
  publishedArtworks: PublicArtwork[];
  publicStatuses: PublicStatus[];
}

interface CreateApiOptions {
  storage: StorageAdapter;
  seedData?: BlogState;
  now?: () => string;
}

export function createPublicBlogApi({ storage, seedData = EMPTY_STATE, now = () => new Date().toISOString() }: CreateApiOptions): PublicBlogApi {
  if (!storage) {
    throw new Error("createPublicBlogApi requires a storage adapter.");
  }

  function readState(): BlogState {
    return normalizeState(storage.read() || seedData);
  }

  function writeState(state: BlogState): void {
    storage.write(normalizeState(state));
  }

  function getSnapshot(): BlogSnapshot {
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
    addComment(articleId: string, body: string, session: Session): Comment {
      const state = readState();
      const article = state.articles.find((item) => item.id === articleId);
      if (!article || article.status !== "published") {
        throw new Error("Comments are only available for published articles.");
      }
      const comment = createComment({ articleId, body, session }, { now: now() });
      writeState({ ...state, comments: [...state.comments, comment] });
      return comment;
    },
    getCommentsForArticle(articleId: string): Comment[] {
      return listCommentsForArticle(readState().comments, articleId);
    },
    getPublishedArticleBySlug(slug: string): PublicArticle | null {
      const article = findArticleBySlug(listPublishedArticles(readState().articles), slug);
      return article ? toPublicArticle(article) : null;
    },
    getArticleReaderPayload(slug: string) {
      const state = readState();
      const articles = listPublishedArticles(state.articles);
      const article = findArticleBySlug(articles, slug);
      if (!article) return null;
      const publicArticle = toPublicArticle(article);
      return { ...publicArticle, outline: getArticleOutline(publicArticle.content), related: getRelatedArticles(publicArticle, articles).map(toPublicArticle) };
    },
    getPublishedArtworks(): PublicArtwork[] {
      return listPublishedArtworks(readState().artworks).map((artwork) => artworkToPublic(artwork));
    },
    getPublishedArtworkBySlug(slug: string): PublicArtwork | null {
      const artwork = findArtworkBySlug(listPublishedArtworks(readState().artworks), slug);
      return artwork ? artworkToPublic(artwork) : null;
    },
    getPublishedArtworkAsset(slug: string, assetId: string, variant: string = "display") {
      const artwork = findArtworkBySlug(listPublishedArtworks(readState().artworks), slug);
      const asset = artwork?.assets?.find((item) => item.id === assetId);
      if (!asset) return null;
      return { key: variant === "thumb" ? asset.thumbKey : asset.displayKey, mimeType: asset.mimeType || "image/webp" };
    },
    getSnapshot,
    queryPublishedArticles(query: string): PublicArticle[] {
      return listPublishedArticles(readState().articles).filter((article) => matchesArticleQuery(article, query)).map(toPublicArticle);
    }
  };
}

function toPublicArticle(article: Article): PublicArticle {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    content: article.content,
    tags: article.tags || [],
    status: "published",
    publishedAt: article.publishedAt || article.scheduledAt || article.updatedAt || "",
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

function normalizeState(state: unknown): BlogState {
  const value = (state || {}) as Partial<BlogState>;
  return {
    articles: Array.isArray(value.articles) ? value.articles : [],
    artworks: Array.isArray(value.artworks) ? value.artworks : [],
    comments: Array.isArray(value.comments) ? value.comments : [],
    statuses: Array.isArray(value.statuses) ? value.statuses : []
  };
}
