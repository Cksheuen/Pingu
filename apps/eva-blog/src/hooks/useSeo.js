import { useEffect } from "react";
import { useLocale } from "./useLocale.jsx";

export function useSeo(route, article) {
  const { t, language } = useLocale();

  useEffect(() => {
    const title = article
      ? `${article.title} — Eva Blog`
      : route.name === "gallery" ? t("seo.gallery")
      : route.name === "now" ? t("seo.now")
      : route.name === "archive" ? t("seo.archive")
      : t("seo.home");

    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = title;

    const description = article?.seoDescription || article?.excerpt || t("seo.description");
    document.querySelector("meta[name='description']")?.setAttribute("content", description);
    document.querySelector("meta[property='og:title']")?.setAttribute("content", title);
    document.querySelector("meta[property='og:description']")?.setAttribute("content", description);

    const canonicalPath = article
      ? (article.assets ? `/gallery/${encodeURIComponent(article.slug)}` : `/article/${encodeURIComponent(article.slug)}`)
      : window.location.pathname;
    // 静态 index.html 没有 canonical link，首次需要创建后复用。
    let canonical = document.querySelector("link[rel='canonical']");
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", `${window.location.origin}${canonicalPath}`);
  }, [route, article, t, language]);
}
