export const ARTICLE_STATUSES = Object.freeze({
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  PUBLISHED: "published",
  UNPUBLISHED: "unpublished"
});

const PUBLIC_STATUSES = new Set([ARTICLE_STATUSES.PUBLISHED, ARTICLE_STATUSES.SCHEDULED]);

export function createSlug(input) {
  const base = String(input || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return base || "post-" + Date.now().toString(36);
}

export function ensureUniqueSlug(slug, articles, currentId) {
  const taken = new Set(
    articles
      .filter((article) => article.id !== currentId)
      .map((article) => article.slug)
  );

  if (!taken.has(slug)) return slug;

  let index = 2;
  let candidate = slug + "-" + index;
  while (taken.has(candidate)) {
    index += 1;
    candidate = slug + "-" + index;
  }
  return candidate;
}

export function estimateReadingMinutes(content) {
  const text = String(content || "").trim();
  if (!text) return 1;
  const latinWords = text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
  const cjkChars = text.match(/[\u4e00-\u9fff]/g) || [];
  return Math.max(1, Math.ceil((latinWords.length + Math.ceil(cjkChars.length / 2)) / 220));
}

export function extractExcerpt(content, maxLength = 180) {
  const text = String(content || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length <= maxLength ? text : text.slice(0, maxLength).trim() + "...";
}

export function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || "").split(",");
  return [...new Set(values.map(String).map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

export function normalizeArticle(input, options = {}) {
  const now = options.now || new Date().toISOString();
  const title = String(input.title || "").trim();
  const content = String(input.content || "").trim();
  if (!title) throw new Error("Article title is required.");
  if (!content) throw new Error("Article content is required.");

  const scheduledAt = normalizeTimestamp(input.scheduledAt, "Scheduled publish time");
  const requestedStatus = Object.values(ARTICLE_STATUSES).includes(input.status)
    ? input.status
    : ARTICLE_STATUSES.DRAFT;
  const shouldPublish = input.publish || input.published === true;
  const status = shouldPublish
    ? ARTICLE_STATUSES.PUBLISHED
    : scheduledAt && requestedStatus !== ARTICLE_STATUSES.PUBLISHED && requestedStatus !== ARTICLE_STATUSES.UNPUBLISHED
      ? ARTICLE_STATUSES.SCHEDULED
      : requestedStatus;

  if (status === ARTICLE_STATUSES.SCHEDULED && !scheduledAt) {
    throw new Error("Scheduled articles require a publish time.");
  }

  const existingPublishedAt = normalizeTimestamp(input.publishedAt, "Published time");
  const publishedAt = status === ARTICLE_STATUSES.PUBLISHED
    ? existingPublishedAt || now
    : status === ARTICLE_STATUSES.SCHEDULED
      ? scheduledAt
      : existingPublishedAt || null;

  return {
    id: input.id || createId("article"),
    title,
    slug: createSlug(input.slug || title),
    content,
    tags: normalizeTags(input.tags),
    status,
    scheduledAt: status === ARTICLE_STATUSES.SCHEDULED ? scheduledAt : null,
    publishedAt,
    unpublishedAt: status === ARTICLE_STATUSES.UNPUBLISHED ? normalizeTimestamp(input.unpublishedAt, "Unpublished time") || now : null,
    createdAt: input.createdAt || now,
    updatedAt: now,
    excerpt: extractExcerpt(content),
    readingMinutes: estimateReadingMinutes(content),
    summary: input.summary || null,
    series: normalizeSeries(input.series || (input.seriesTitle || input.seriesSlug ? input : null)),
    relatedSlugs: normalizeRelatedSlugs(input.relatedSlugs),
    cover: normalizeCover(input.cover),
    seoDescription: String(input.seoDescription || input.excerpt || "").trim().slice(0, 220)
  };
}

export function publishArticle(article, options = {}) {
  const now = options.now || new Date().toISOString();
  return {
    ...article,
    status: ARTICLE_STATUSES.PUBLISHED,
    scheduledAt: null,
    publishedAt: article.publishedAt || now,
    unpublishedAt: null,
    updatedAt: now
  };
}

export function unpublishArticle(article, options = {}) {
  const now = options.now || new Date().toISOString();
  return {
    ...article,
    status: ARTICLE_STATUSES.UNPUBLISHED,
    scheduledAt: null,
    unpublishedAt: now,
    updatedAt: now
  };
}

export function isArticlePublic(article, now = new Date().toISOString()) {
  if (!article || !PUBLIC_STATUSES.has(article.status)) return false;
  if (article.status === ARTICLE_STATUSES.SCHEDULED) {
    return Boolean(article.scheduledAt && String(article.scheduledAt).localeCompare(String(now)) <= 0);
  }
  return true;
}

export function listPublishedArticles(articles, options = {}) {
  const now = options.now || new Date().toISOString();
  return [...articles]
    .filter((article) => isArticlePublic(article, now))
    .sort((a, b) => String(b.publishedAt || b.scheduledAt || b.updatedAt).localeCompare(String(a.publishedAt || a.scheduledAt || a.updatedAt)));
}

export function listAllArticles(articles) {
  return [...articles].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function findArticleBySlug(articles, slug) {
  return articles.find((article) => article.slug === slug) || null;
}

export function parseMarkdownArticle(filename, markdown, options = {}) {
  const now = options.now || new Date().toISOString();
  const text = String(markdown || "").trim();
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const fallbackTitle = String(filename || "Imported article")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();

  return normalizeArticle({
    title: titleMatch ? titleMatch[1].trim() : fallbackTitle,
    content: text,
    tags: options.tags || [],
    status: options.status || ARTICLE_STATUSES.DRAFT,
    createdAt: now
  }, { now });
}

export function matchesArticleQuery(article, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [
    article.title,
    article.excerpt,
    article.content,
    article.series?.title,
    ...(article.tags || [])
  ].join(" ").toLowerCase().includes(needle);
}

export function getArticleOutline(content) {
  return String(content || "").split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    if (!match) return [];
    const text = match[2].trim();
    return [{ depth: match[1].length, text, id: createSlug(text), line: index + 1 }];
  });
}

export function listArticleArchives(articles, options = {}) {
  const groups = new Map();
  for (const article of listPublishedArticles(articles, options)) {
    const year = String(article.publishedAt || article.scheduledAt || article.updatedAt).slice(0, 4);
    groups.set(year, [...(groups.get(year) || []), article]);
  }
  return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([year, entries]) => ({ year, entries }));
}

export function listArticleTags(articles, options = {}) {
  const counts = new Map();
  for (const article of listPublishedArticles(articles, options)) {
    for (const tag of article.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count, slug: createSlug(tag) }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

export function listArticleSeries(articles, options = {}) {
  const groups = new Map();
  for (const article of listPublishedArticles(articles, options)) {
    if (!article.series?.slug) continue;
    const current = groups.get(article.series.slug) || { ...article.series, entries: [] };
    current.entries.push(article);
    groups.set(article.series.slug, current);
  }
  return [...groups.values()]
    .map((series) => ({ ...series, entries: series.entries.sort((left, right) => (left.series?.order || 0) - (right.series?.order || 0)) }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export function getRelatedArticles(article, articles, options = {}) {
  const limit = options.limit || 3;
  const candidates = listPublishedArticles(articles, options).filter((item) => item.id !== article.id);
  return candidates
    .map((candidate) => ({ candidate, score: relatedScore(article, candidate) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || String(right.candidate.publishedAt).localeCompare(String(left.candidate.publishedAt)))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function createRevision(article, options = {}) {
  const now = options.now || new Date().toISOString();
  return {
    id: options.id || createId("revision"),
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
    createdAt: now,
    label: options.label || "Saved revision"
  };
}

export function restoreRevision(article, revision, options = {}) {
  const now = options.now || new Date().toISOString();
  if (revision.articleId !== article.id) throw new Error("Revision does not belong to this article.");
  return normalizeArticle({
    ...article,
    ...revision,
    id: article.id,
    status: article.status,
    publishedAt: article.publishedAt,
    createdAt: article.createdAt
  }, { now });
}

export function inspectPublication(article) {
  const issues = [];
  if (article.title.length < 5) issues.push({ code: "short-title", message: "Use a more descriptive title." });
  if (!article.excerpt || article.excerpt.length < 40) issues.push({ code: "short-excerpt", message: "Add enough prose for a useful reader excerpt." });
  if (!article.summary?.text) issues.push({ code: "missing-summary", message: "Generate a reader summary before publication." });
  if ((article.cover?.src || article.cover?.displayKey) && !article.cover?.alt) issues.push({ code: "missing-cover-alt", message: "Describe the cover image for readers using assistive technology." });
  if (article.status === ARTICLE_STATUSES.SCHEDULED && !article.scheduledAt) issues.push({ code: "missing-schedule", message: "Choose a scheduled publish time." });
  return { ready: issues.length === 0, issues };
}

function normalizeSeries(input) {
  const title = String(input?.seriesTitle ?? input?.title ?? "").trim();
  const slugInput = String(input?.seriesSlug ?? input?.slug ?? "").trim();
  if (!title && !slugInput) return null;
  const order = Number(input?.seriesOrder ?? input?.order ?? 0);
  return {
    title: title || slugInput,
    slug: createSlug(slugInput || title),
    order: Number.isFinite(order) && order >= 0 ? Math.floor(order) : 0
  };
}

function normalizeRelatedSlugs(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean).map((item) => createSlug(item)))].slice(0, 6);
}

function normalizeCover(value) {
  if (!value || typeof value !== "object") return null;
  const src = String(value.src || "").trim();
  const displayKey = String(value.displayKey || "").trim();
  if (!src && !displayKey) return null;
  return {
    src,
    displayKey,
    alt: String(value.alt || "").trim(),
    focalPoint: String(value.focalPoint || "center").trim()
  };
}

function normalizeTimestamp(value, label) {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(label + " is invalid.");
  return new Date(time).toISOString();
}

function relatedScore(article, candidate) {
  const sharedTags = (article.tags || []).filter((tag) => candidate.tags?.includes(tag)).length;
  const sameSeries = article.series?.slug && article.series.slug === candidate.series?.slug ? 5 : 0;
  return sharedTags * 2 + sameSeries;
}

function createId(prefix) {
  const randomPart = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  return prefix + "_" + randomPart;
}
