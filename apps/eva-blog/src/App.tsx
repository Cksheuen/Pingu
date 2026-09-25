import { useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { LocaleProvider, useLocale } from "./hooks/useLocale";
import { useRoute } from "./hooks/useRoute";
import { usePublicData } from "./hooks/usePublicData";
import { useSeo } from "./hooks/useSeo";
import { useScrollUi } from "./hooks/useScrollUi";
import { useHeroMeasure } from "./hooks/useHeroMeasure";
import { useHeaderScroll } from "./hooks/useHeaderScroll";
import { useHeroText } from "./hooks/useHeroText";
import { useFlyingTabs } from "./hooks/useFlyingTabs";
import { useRouteArtworkMorph } from "./hooks/useRouteArtworkMorph";
import { ArtworkCanvas } from "./components/ArtworkCanvas";
import { SiteHeader } from "./components/SiteHeader";
import { ErrorBanner } from "./components/ErrorBanner";
import { HomeView } from "./views/HomeView";
import { ArchiveView } from "./views/ArchiveView";
import { NowView } from "./views/NowView";
import { GalleryView } from "./views/GalleryView";
import { ArticleView } from "./views/ArticleView";
import { getArtworkBrandSrc, getArtworkConfig, isTabRoute } from "./lib/artworkConfig";
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

  const hasHero = isTabRoute(route.name);
  const config = getArtworkConfig(route.name);
  const { morphT, prevConfig } = useRouteArtworkMorph(config);
  const { articleRef, progressRef, backToTopRef, scrollToTop } = useScrollUi();

  // hero → header 形变所需的测量 ref
  const heroRef = useRef<HTMLElement>(null);
  const brandSlotRef = useRef<HTMLDivElement>(null);
  const heroTabRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const navLinkRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  // 拆分后的 5 个 hook（useArtworkCanvas 在 ArtworkCanvas 组件内部调用）
  const { measured, measurementsRef } = useHeroMeasure(hasHero, { heroRef, brandSlotRef, heroTabRefs, navLinkRefs }, route.name);
  const headerMotion = useHeaderScroll(hasHero);
  const heroTextItems = useHeroText(hasHero);
  const tabMotions = useFlyingTabs(hasHero, measurementsRef);

  const article = selectedSlug
    ? articles.find((a) => a.slug === selectedSlug) || null
    : articles[0] || null;

  const seoArticle = route.name === "article" ? article : route.name === "gallery" && route.artworkSlug
    ? artworks.find((a) => a.slug === route.artworkSlug)
    : null;

  useSeo(route, seoArticle as PublicArticle | null);

  // 跟踪滚动位置，用于跨 tab 状态保持
  const scrollYRef = useRef(0);
  const prevRouteRef = useRef(route.name);

  useEffect(() => {
    const onScroll = () => { scrollYRef.current = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 路由切换时的滚动行为：
  // - tab → tab：保持滚动状态（header 状态切换后仍为 header，hero 状态切换后仍为 hero）
  // - 其他导航（进入文章等）：回到顶部
  // setTimeout 延迟到浏览器完成 hash 导航的默认滚动后再恢复
  useEffect(() => {
    const prev = prevRouteRef.current;
    const isTabToTab = isTabRoute(prev) && isTabRoute(route.name);

    if (isTabToTab && scrollYRef.current > window.innerHeight * 0.5) {
      // header 状态：延迟到浏览器默认滚动后，滚到 hero 过渡区之后
      const timer = setTimeout(() => {
        window.scrollTo(0, window.innerHeight * 0.9);
      }, 0);
      prevRouteRef.current = route.name;
      return () => clearTimeout(timer);
    }

    window.scrollTo(0, 0);
    prevRouteRef.current = route.name;
  }, [route.name]);

  useEffect(() => {
    if (route.name === "article" && article) {
      loadComments(article.id);
    }
  }, [route.name, article, loadComments]);

  // 8 秒超时自动滚动（仅在有 hero 的 tab 页）
  // route.name 加入依赖：tab 切换时重置计时器，避免切换后旧 timer 触发滚动
  useEffect(() => {
    if (!hasHero) return;
    let autoScrolling = false;
    const timer = setTimeout(() => {
      autoScrolling = true;
      window.scrollTo({ top: window.innerHeight, behavior: "smooth" });
    }, 8000);
    const cancel = () => {
      if (!autoScrolling) clearTimeout(timer);
    };
    window.addEventListener("scroll", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { once: true, passive: true });
    window.addEventListener("keydown", cancel, { once: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, [hasHero, route.name]);

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

  // Hero props 共享给所有 tab 视图
  const heroProps = { heroRef, heroTabRefs, heroTextItems };

  return (
    <>
      <SiteHeader
        route={route}
        hasHero={hasHero}
        headerMotion={headerMotion}
        brandSlotRef={brandSlotRef}
        navLinkRefs={navLinkRefs}
        artworkSrc={getArtworkBrandSrc(config)}
        onBrandClick={handleBrandClick}
      />
      <ErrorBanner error={error} />
      <main className={`page-main page-public${hasHero ? " has-hero" : ""}`} key={route.name + (route.artworkSlug ?? "")}>
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
          <ArchiveView articles={articles} archives={archives} tags={tags} series={series} {...heroProps} />
        ) : route.name === "now" ? (
          <NowView publicStatuses={publicStatuses} {...heroProps} />
        ) : route.name === "gallery" ? (
          <GalleryView artworks={artworks} artworkSlug={route.artworkSlug ?? null} loading={loading} {...heroProps} />
        ) : (
          <HomeView
            articles={articles}
            artworks={artworks}
            publicStatuses={publicStatuses}
            loading={loading}
            {...heroProps}
          />
        )}
      </main>
      {/* Artwork canvas：背景透明化 + 软边羽化，支持路由切换 liquid morph */}
      <ArtworkCanvas
        active={hasHero}
        measured={measured}
        measurementsRef={measurementsRef}
        config={config}
        prevConfig={prevConfig}
        morphT={morphT}
      />
      {/* Flying tabs：沿贝塞尔曲线从 hero 飞到 header nav，排版连续过渡 */}
      {hasHero && measured && tabMotions.map((tm, i) => (
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
