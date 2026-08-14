import { useLocale } from "../hooks/useLocale.jsx";
import { describeLocalizedStatus } from "../services/locale.js";
import { ArticleCard } from "../components/ArticleCard.jsx";
import { ArtworkImage } from "../components/ArtworkCard.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { RichText } from "../components/RichText.jsx";

export function HomeView({ articles, artworks, publicStatuses, loading }) {
  const { t, locale } = useLocale();
  const article = articles[0];
  const artwork = artworks[0];

  return (
    <>
      <section className="home-hero route-enter">
        <div className="hero-copy">
          <p className="eyebrow">{t("home.kicker")}</p>
          <h1><RichText html={t("home.title")} /></h1>
          <p className="hero-intro">{t("home.intro")}</p>
          <div className="hero-actions">
            <a className="primary-link" href={article ? `#/article/${encodeURIComponent(article.slug)}` : "#/archive"}>
              {t(article ? "home.latest" : "home.archive")} <span>↗</span>
            </a>
            <a className="text-link" href="#/gallery">{t("home.gallery")}</a>
          </div>
        </div>
        <div className="hero-figure" aria-label={t("home.plate")}>
          {artwork ? (
            <ArtworkImage artwork={artwork} className="hero-artwork" />
          ) : (
            <img src="/public/assets/blog-cover.png" alt="" className="hero-artwork" loading="lazy" />
          )}
          <div className="figure-caption">
            <span>{t("home.plate")}</span>
            <strong>{artwork?.title || t("home.fallbackArtwork")}</strong>
          </div>
        </div>
      </section>
      <section className="home-ledger route-enter">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t("home.recent")}</p>
            <h2>{t("home.start")}</h2>
          </div>
          <a className="text-link" href="#/archive">{t("home.viewArchive")}</a>
        </div>
        <div className="home-article-grid">
          {loading ? (
            <EmptyState text={t("home.opening")} />
          ) : articles.slice(0, 3).length ? (
            articles.slice(0, 3).map((item, index) => (
              <ArticleCard key={item.id} article={item} variant={index === 0 ? "featured" : ""} />
            ))
          ) : (
            <EmptyState text={t("home.empty")} />
          )}
        </div>
      </section>
      <section className="signal-ribbon route-enter">
        <div>
          <p className="eyebrow">{t("nav.now")}</p>
          <strong>{describeLocalizedStatus(publicStatuses[0], locale)}</strong>
        </div>
        <a href="#/now">{t("home.follow")}</a>
      </section>
    </>
  );
}
