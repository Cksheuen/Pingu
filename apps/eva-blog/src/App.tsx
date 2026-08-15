import { useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { LocaleProvider, useLocale } from "./hooks/useLocale";
import { useRoute } from "./hooks/useRoute";
import { usePublicData } from "./hooks/usePublicData";
import { useSeo } from "./hooks/useSeo";
import { useScrollUi } from "./hooks/useScrollUi";
import { useHeroMorph } from "./hooks/useHeroMorph";
import { SiteHeader } from "./components/SiteHeader";
import { ErrorBanner } from "./components/ErrorBanner";
import { HomeView } from "./views/HomeView";
import { ArchiveView } from "./views/ArchiveView";
import { NowView } from "./views/NowView";
import { GalleryView } from "./views/GalleryView";
import { ArticleView } from "./views/ArticleView";
import type { PublicArticle } from "./types";

const TAB_PATHS = ["/", "/archive", "/now", "/gallery"];

function AppContent() {
  const { t } = useLocale();
  const { route, selectedSlug } = useRoute();
  const {
    articles, artworks, archives, tags, series, publicStatuses,
    loading, error, setError,
    commentsByArticle, commentsLoading, loadComments, addComment
  } = usePublicData();

  const isHome = route.name === "home";
  const { articleRef, progressRef, backToTopRef, scrollToTop } = useScrollUi();

  // hero → header 形变所需的测量 ref
  const heroRef = useRef<HTMLElement>(null);
  const brandSlotRef = useRef<HTMLDivElement>(null);
  const heroTabRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const navLinkRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const artwork = artworks[0];
  const artworkSrc = artwork?.assets?.[0]?.src || "/public/assets/blog-cover.png";
  const {
    measured,
    canvasRef,
    artwork: artworkMotion,
    header: headerMotion,
    heroTextItems,
    tabs: tabMotions,
  } = useHeroMorph(isHome, { heroRef, brandSlotRef, heroTabRefs, navLinkRefs, artworkSrc });

  const article = selectedSlug
    ? articles.find((a) => a.slug === selectedSlug) || null
    : articles[0] || null;

  const seoArticle = route.name === "article" ? article : route.name === "gallery" && route.artworkSlug
    ? artworks.find((a) => a.slug === route.artworkSlug)
    : null;

  useSeo(route, seoArticle as PublicArticle | null);

  // 路由切换时回顶，确保 hero 形变从正确位置开始
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.name]);

  useEffect(() => {
    if (route.name === "article" && article) {
      loadComments(article.id);
    }
  }, [route.name, article, loadComments]);

  const handleBrandClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    window.location.hash = "#/";
    scrollToTop();
  }, [scrollToTop]);

  const handleCommentSubmit = useCallback(async (body: string) => {
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
      <SiteHeader
        route={route}
        isHome={isHome}
        headerMotion={headerMotion}
        brandSlotRef={brandSlotRef}
        navLinkRefs={navLinkRefs}
        artworkSrc={artworkSrc}
        onBrandClick={handleBrandClick}
      />
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
          <GalleryView artworks={artworks} artworkSlug={route.artworkSlug ?? null} loading={loading} />
        ) : (
          <HomeView
            articles={articles}
            artworks={artworks}
            publicStatuses={publicStatuses}
            loading={loading}
            heroRef={heroRef}
            heroTabRefs={heroTabRefs}
            heroTextItems={heroTextItems}
          />
        )}
      </main>
      {/* Artwork canvas：背景透明化 + 软边羽化，末尾淡出与 brand-mark 交叉 */}
      {isHome && measured && (
        <motion.canvas
          ref={canvasRef}
          className="artwork-canvas"
          style={{ zIndex: artworkMotion.zIndex, opacity: artworkMotion.opacity }}
        />
      )}
      {/* Flying tabs：沿贝塞尔曲线从 hero 飞到 header nav，排版连续过渡 */}
      {isHome && measured && tabMotions.map((tm, i) => (
        <motion.a
          key={TAB_PATHS[i]}
          className="flying-tab"
          href={`#${TAB_PATHS[i]}`}
          style={{
            x: tm.x,
            y: tm.y,
            opacity: tm.opacity,
            pointerEvents: tm.pointerEvents,
            fontSize: tm.fontMorph.fontSize,
            letterSpacing: tm.fontMorph.letterSpacing,
            paddingTop: tm.fontMorph.paddingTop,
            paddingBottom: tm.fontMorph.paddingBottom,
            lineHeight: tm.fontMorph.lineHeight,
            color: tm.fontMorph.color,
          }}
        >
          {t(`nav.${TAB_PATHS[i] === "/" ? "reader" : TAB_PATHS[i].slice(1)}`)}
        </motion.a>
      ))}
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
