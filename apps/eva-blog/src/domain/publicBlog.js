const PUBLIC_STATUSES = new Set(["published", "scheduled"]);

export function isArticlePublic(article, now = new Date().toISOString()) {
  if (!article || !PUBLIC_STATUSES.has(article.status)) return false;
  return article.status === "published" || Boolean(article.scheduledAt && String(article.scheduledAt).localeCompare(String(now)) <= 0);
}

export function listPublishedArticles(articles, options = {}) {
  const now = options.now || new Date().toISOString();
  return [...articles]
    .filter((article) => isArticlePublic(article, now))
    .sort((a, b) => String(b.publishedAt || b.scheduledAt || b.updatedAt).localeCompare(String(a.publishedAt || a.scheduledAt || a.updatedAt)));
}

export function findArticleBySlug(articles, slug) {
  return articles.find((article) => article.slug === slug) || null;
}

export function matchesArticleQuery(article, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [article.title, article.excerpt, article.content, article.series?.title, ...(article.tags || [])].join(" ").toLowerCase().includes(needle);
}

export function getArticleOutline(content) {
  return String(content || "").split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    return match ? [{ depth: match[1].length, text: match[2].trim(), id: createSlug(match[2]), line: index + 1 }] : [];
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
  return [...counts.entries()].map(([tag, count]) => ({ tag, count, slug: createSlug(tag) })).sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

export function listArticleSeries(articles, options = {}) {
  const groups = new Map();
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

export function getRelatedArticles(article, articles, options = {}) {
  const limit = options.limit || 3;
  return listPublishedArticles(articles, options)
    .filter((candidate) => candidate.id !== article.id)
    .map((candidate) => ({ candidate, score: relatedScore(article, candidate) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || String(right.candidate.publishedAt).localeCompare(String(left.candidate.publishedAt)))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function relatedScore(article, candidate) {
  const sharedTags = (article.tags || []).filter((tag) => candidate.tags?.includes(tag)).length;
  const sameSeries = article.series?.slug && article.series.slug === candidate.series?.slug ? 5 : 0;
  return sharedTags * 2 + sameSeries;
}

function createSlug(input) {
  const value = String(input || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return value || "section";
}
