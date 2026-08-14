import { useState } from "react";
import { useLocale } from "../hooks/useLocale.jsx";
import { renderMarkdown, outlineFromContent } from "../lib/markdown.js";
import { Comments } from "../components/Comments.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { ReadingProgress } from "../components/ReadingProgress.jsx";
import { BackToTop } from "../components/BackToTop.jsx";

export function ArticleView({ article, articles, loading, comments, commentsLoading, articleRef, progressRef, backToTopRef, onBackToTop, onCommentSubmit, onCopyLink }) {
  const { t, formatDate, language } = useLocale();
  const [copied, setCopied] = useState(false);

  if (!article) {
    return <EmptyState text={loading ? t("reader.loading") : t("reader.unavailable")} />;
  }

  const outline = article.outline || outlineFromContent(article.content);
  const summary = article.summary?.text || t("reader.summaryPending");
  const related = article.related || articles.filter((candidate) => candidate.id !== article.id && (candidate.tags || []).some((tag) => article.tags?.includes(tag))).slice(0, 3);

  const handleCopyLink = async () => {
    await onCopyLink();
    setCopied(true);
  };

  return (
    <>
      <ReadingProgress progressRef={progressRef} />
      <article className="long-reader route-enter" ref={articleRef}>
        <div className="reader-progress" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(8, (article.readingMinutes || 1) * 13))}%` }} />
        </div>
        <div className="reader-crumb">
          <a href="#/archive">{t("reader.archive")}</a>
          <span>/</span>
          <span>{article.series?.title || t("reader.fieldNotes")}</span>
        </div>
        <header className="article-heading">
          <p className="eyebrow">
            {formatDate(article.publishedAt || article.updatedAt)} · {t("reader.minRead", { count: article.readingMinutes || 1 })}
          </p>
          <h1>{article.title}</h1>
          <p className="article-deck">{article.excerpt}</p>
          <div className="tag-row">
            {(article.tags || []).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </header>
        <div className="reader-layout">
          <aside className="reader-aside">
            {outline.length > 0 && (
              <div className="toc">
                <span className="eyebrow">{t("reader.onThisPage")}</span>
                {outline.map((item) => (
                  <a key={item.id} href={`#${item.id}`} className={`depth-${item.depth}`}>
                    {item.text}
                  </a>
                ))}
              </div>
            )}
            <div className="reader-fact">
              <span>{t("reader.digest")}</span>
              <p>{summary}</p>
              <small>{article.summary?.provider || t("reader.pending")}</small>
            </div>
          </aside>
          <div className="reader-manuscript">
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(article.content) }} />
            <div className="reader-tools">
              <button type="button" onClick={handleCopyLink}>{copied ? t("reader.copied") : t("reader.copy")}</button>
              <span>{t("reader.sourceChars", { count: article.content.length.toLocaleString(language === "zh" ? "zh-CN" : "en") })}</span>
            </div>
            {related.length > 0 && (
              <section className="related-section">
                <p className="eyebrow">{t("reader.continue")}</p>
                <div>
                  {related.map((item) => (
                    <a key={item.id} href={`#/article/${encodeURIComponent(item.slug)}`}>
                      <strong>{item.title}</strong>
                      <span>{t("reader.minutes", { count: item.readingMinutes || 1 })}</span>
                    </a>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
        <Comments
          article={article}
          comments={comments}
          loading={commentsLoading}
          onSubmit={onCommentSubmit}
        />
      </article>
      <BackToTop backToTopRef={backToTopRef} onClick={onBackToTop} />
    </>
  );
}
