import { estimateReadingMinutes, extractExcerpt } from "../domain/blog.js";
import { describeStatus, listPublicStatuses } from "../domain/status.js";

export function createDeterministicSummaryProvider() {
  return {
    name: "deterministic-fallback",
    async summarizeArticle(article) {
      const firstSentence = firstSentenceOf(article.content) || extractExcerpt(article.content, 140);
      const tags = article.tags?.length ? ` Tags: ${article.tags.join(", ")}.` : "";
      return {
        provider: "deterministic-fallback",
        text: `${firstSentence} Estimated reading time: ${estimateReadingMinutes(article.content)} min.${tags}`,
        generatedAt: stableTimestamp(article.updatedAt || article.publishedAt || article.createdAt)
      };
    },
    async summarizeActivity({ statuses = [], articles = [] } = {}) {
      const latestStatus = listPublicStatuses(statuses, 1)[0];
      const latestArticle = [...articles]
        .filter((article) => article.status === "published")
        .sort((a, b) => String(b.publishedAt || b.updatedAt).localeCompare(String(a.publishedAt || a.updatedAt)))[0];

      const statusText = describeStatus(latestStatus);
      const articleText = latestArticle
        ? `Latest article: ${latestArticle.title}.`
        : "No published article yet.";

      return {
        provider: "deterministic-fallback",
        text: `${statusText} ${articleText}`,
        generatedAt: stableTimestamp(latestStatus?.updatedAt || latestArticle?.updatedAt)
      };
    }
  };
}

export async function summarizeArticle(article, provider = createDeterministicSummaryProvider()) {
  if (provider?.summarizeArticle) {
    return provider.summarizeArticle(article);
  }
  if (provider?.generate) {
    return provider.generate({
      task: "article-summary",
      input: {
        title: article.title,
        tags: article.tags,
        content: article.content
      }
    });
  }
  return createDeterministicSummaryProvider().summarizeArticle(article);
}

export async function summarizeActivity(input, provider = createDeterministicSummaryProvider()) {
  if (provider?.summarizeActivity) {
    return provider.summarizeActivity(input);
  }
  if (provider?.generate) {
    return provider.generate({
      task: "recent-activity-summary",
      input
    });
  }
  return createDeterministicSummaryProvider().summarizeActivity(input);
}

function firstSentenceOf(content) {
  const text = String(content || "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = text.match(/^(.{24,220}?[.!?。！？])(?:\s|$)/);
  return match ? match[1] : "";
}

function stableTimestamp(value) {
  return value || "deterministic";
}
