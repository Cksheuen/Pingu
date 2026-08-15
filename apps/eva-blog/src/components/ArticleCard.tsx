import { useLocale } from "../hooks/useLocale";
import type { PublicArticle } from "../types";

interface ArticleCardProps {
  article: PublicArticle;
  variant?: string;
}

export function ArticleCard({ article, variant = "" }: ArticleCardProps) {
  const { t } = useLocale();
  return (
    <article className={`article-card ${variant}`}>
      <div className="article-card-index">
        {String(article.publishedAt || article.updatedAt).slice(0, 4)} / {t("reader.minRead", { count: article.readingMinutes || 1 })}
      </div>
      <h2>
        <a href={`#/article/${encodeURIComponent(article.slug)}`}>{article.title}</a>
      </h2>
      <p>{article.excerpt}</p>
      <div className="card-footer">
        <div className="tag-row">
          {(article.tags || []).slice(0, 3).map((tag, index) => (
            <span key={index}>{tag}</span>
          ))}
        </div>
        <a href={`#/article/${encodeURIComponent(article.slug)}`} aria-label={`${t("home.latest")}: ${article.title}`}>
          ↗
        </a>
      </div>
    </article>
  );
}
