import { useEffect, useCallback } from "react";
import { LocaleProvider, useLocale } from "./hooks/useLocale.jsx";
import { useRoute } from "./hooks/useRoute.js";
import { usePublicData } from "./hooks/usePublicData.js";
import { useSeo } from "./hooks/useSeo.js";
import { useScrollUi } from "./hooks/useScrollUi.js";
import { SiteHeader } from "./components/SiteHeader.jsx";
import { ErrorBanner } from "./components/ErrorBanner.jsx";
import { HomeView } from "./views/HomeView.jsx";
import { ArchiveView } from "./views/ArchiveView.jsx";
import { NowView } from "./views/NowView.jsx";
import { GalleryView } from "./views/GalleryView.jsx";
import { ArticleView } from "./views/ArticleView.jsx";

function AppContent() {
  const { t } = useLocale();
  const { route, selectedSlug } = useRoute();
  const {
    articles, artworks, archives, tags, series, publicStatuses,
    loading, error, setError,
    commentsByArticle, commentsLoading, loadComments, addComment
  } = usePublicData();

  const isHome = route.name === "home";
  const { condensed, setCondensed, articleRef, progressRef, backToTopRef, scrollToTop } = useScrollUi(isHome);

  const article = selectedSlug
    ? articles.find((a) => a.slug === selectedSlug) || null
    : articles[0] || null;

  const seoArticle = route.name === "article" ? article : route.name === "gallery" && route.artworkSlug
    ? artworks.find((a) => a.slug === route.artworkSlug)
    : null;

  useSeo(route, seoArticle);

  useEffect(() => {
    if (route.name === "article" && article) {
      loadComments(article.id);
    }
  }, [route.name, article, loadComments]);

  useEffect(() => {
    if (!isHome) setCondensed(false);
  }, [isHome, setCondensed]);

  const handleBrandClick = useCallback((e) => {
    e.preventDefault();
    window.location.hash = "#/";
    scrollToTop();
  }, [scrollToTop]);

  const handleCommentSubmit = useCallback(async (body) => {
    if (!article) return;
    try {
      const response = await fetch(`/api/articles/${encodeURIComponent(article.id)}/comments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.assign(`/api/auth/github/start?redirect=${encodeURIComponent(window.location.href)}`);
        return;
      }
      if (!response.ok) throw new Error(payload.error || "Comment could not be posted.");
      addComment(article.id, payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [article, addComment, setError]);

  const handleCopyLink = useCallback(async () => {
    await navigator.clipboard?.writeText(window.location.href);
  }, []);

  const comments = article ? commentsByArticle.get(article.id) || [] : [];
  const commentsLoadingArticle = article ? commentsLoading.has(article.id) : false;

  return (
    <>
      <SiteHeader route={route} condensed={isHome && condensed} onBrandClick={handleBrandClick} />
      <ErrorBanner error={error} />
      <main className="page-main page-public" key={route.name + (route.artworkSlug ?? "")}>
        {route.name === "article" ? (
          <ArticleView
            article={article}
            articles={articles}
            loading={loading}
            comments={comments}
            commentsLoading={commentsLoadingArticle}
            articleRef={articleRef}
            progressRef={progressRef}
            backToTopRef={backToTopRef}
            onBackToTop={scrollToTop}
            onCommentSubmit={handleCommentSubmit}
            onCopyLink={handleCopyLink}
          />
        ) : route.name === "archive" ? (
          <ArchiveView articles={articles} archives={archives} tags={tags} series={series} />
        ) : route.name === "now" ? (
          <NowView publicStatuses={publicStatuses} />
        ) : route.name === "gallery" ? (
          <GalleryView artworks={artworks} artworkSlug={route.artworkSlug} loading={loading} />
        ) : (
          <HomeView articles={articles} artworks={artworks} publicStatuses={publicStatuses} loading={loading} />
        )}
      </main>
      <footer className="app-footer">
        <span>{t("footer.reader")}</span>
        <span>{t("footer.scope")}</span>
      </footer>
    </>
  );
}

export function App() {
  return (
    <LocaleProvider>
      <AppContent />
    </LocaleProvider>
  );
}
