import type { Article, ArticleOutlineItem, ArticleSeries } from "../types";

const PUBLIC_STATUSES = new Set(["published", "scheduled"]);

// 领域查询只读取少数字段，用结构化约束保持宽松：
// 测试夹具与 seed 数据可以只提供部分字段。
type ArticleLike = {
  status?: string;
  publishedAt?: string | null;
  scheduledAt?: string | null;
  updatedAt?: string;
};

export function isArticlePublic(article: ArticleLike | null | undefined, now: string = new Date().toISOString()): boolean {
  if (!article || !PUBLIC_STATUSES.has(article.status ?? "")) return false;
  return article.status === "published" || Boolean(article.scheduledAt && String(article.scheduledAt).localeCompare(String(now)) <= 0);
}

export function listPublishedArticles<T extends ArticleLike>(articles: T[], options: { now?: string } = {}): T[] {
  const now = options.now || new Date().toISOString();
  return [...articles]
    .filter((article) => isArticlePublic(article, now))
    .sort((a, b) => String(b.publishedAt || b.scheduledAt || b.updatedAt).localeCompare(String(a.publishedAt || a.scheduledAt || a.updatedAt)));
}

export function findArticleBySlug<T extends { slug?: string }>(articles: T[], slug: string): T | null {
  return articles.find((article) => article.slug === slug) || null;
}

type QueryableArticle = {
  title?: string;
  excerpt?: string;
  content?: string;
  series?: { title?: string } | null;
  tags?: string[];
};

export function matchesArticleQuery(article: QueryableArticle, query: string): boolean {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [article.title, article.excerpt, article.content, article.series?.title, ...(article.tags || [])].join(" ").toLowerCase().includes(needle);
}

export function getArticleOutline(content: string): ArticleOutlineItem[] {
  return String(content || "").split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    return match ? [{ depth: match[1].length, text: match[2].trim(), id: createSlug(match[2]), line: index + 1 }] : [];
  });
}

export function listArticleArchives<T extends ArticleLike>(articles: T[], options: { now?: string } = {}): Array<{ year: string; entries: T[] }> {
  const groups = new Map<string, T[]>();
  for (const article of listPublishedArticles(articles, options)) {
    const year = String(article.publishedAt || article.scheduledAt || article.updatedAt).slice(0, 4);
    groups.set(year, [...(groups.get(year) || []), article]);
  }
  return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([year, entries]) => ({ year, entries }));
}

type TaggableArticle = ArticleLike & { tags?: string[] };

export function listArticleTags<T extends TaggableArticle>(articles: T[], options: { now?: string } = {}): Array<{ tag: string; count: number; slug: string }> {
  const counts = new Map<string, number>();
  for (const article of listPublishedArticles(articles, options)) {
    for (const tag of article.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count, slug: createSlug(tag) })).sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

type SeriesArticle = ArticleLike & { series?: ArticleSeries | null; title: string };

export function listArticleSeries<T extends SeriesArticle>(articles: T[], options: { now?: string } = {}): Array<ArticleSeries & { entries: T[] }> {
  const groups = new Map<string, ArticleSeries & { entries: T[] }>();
  for (const article of listPublishedArticles(articles, options)) {
    if (!article.series?.slug) continue;
    const series = groups.get(article.series.slug) || { ...article.series, entries: [] };
    series.entries.push(article);
    groups.set(article.series.slug, series);
  }
  return [...groups.values()]
    .map((series) => ({ ...series, entries: series.entries.sort((left, right) => (left.series?.order || 0) - (right.series?.order || 0)) }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

type RelatableArticle = ArticleLike & {
  id: string;
  tags?: string[];
  series?: ArticleSeries | null;
};

// article 与 articles 可以是不同的具体类型（如 PublicArticle 与存储层 Article），
// 只要都满足 RelatableArticle 即可；返回类型跟随 articles。
export function getRelatedArticles<T extends RelatableArticle>(article: RelatableArticle, articles: T[], options: { now?: string; limit?: number } = {}): T[] {
  const limit = options.limit || 3;
  return listPublishedArticles(articles, options)
    .filter((candidate) => candidate.id !== article.id)
    .map((candidate) => ({ candidate, score: relatedScore(article, candidate) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || String(right.candidate.publishedAt).localeCompare(String(left.candidate.publishedAt)))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function relatedScore(article: RelatableArticle, candidate: RelatableArticle): number {
  const sharedTags = (article.tags || []).filter((tag) => candidate.tags?.includes(tag)).length;
  const sameSeries = article.series?.slug && article.series.slug === candidate.series?.slug ? 5 : 0;
  return sharedTags * 2 + sameSeries;
}

function createSlug(input: string): string {
  const value = String(input || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return value || "section";
}

// 供公开层使用的类型再导出
export type { Article };
