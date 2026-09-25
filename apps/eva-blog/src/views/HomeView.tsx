import { useLocale } from "../hooks/useLocale";
import { describeLocalizedStatus } from "../services/locale";
import { ArticleCard } from "../components/ArticleCard";
import { EmptyState } from "../components/EmptyState";
import { HeroSection } from "../components/HeroSection";
import type { PublicArticle, PublicArtwork, PublicStatus } from "../types";
import type { HeroProps } from "../hooks/heroTypes";

interface HomeViewProps extends HeroProps {
  articles: PublicArticle[];
  artworks: PublicArtwork[];
  publicStatuses: PublicStatus[];
  loading: boolean;
}

export function HomeView({ articles, artworks, publicStatuses, loading, heroRef, heroTabRefs, heroTextItems }: HomeViewProps) {
  const { t, locale } = useLocale();
  const article = articles[0];

  return (
    <>
      <HeroSection
        heroRef={heroRef}
        heroTabRefs={heroTabRefs}
        heroTextItems={heroTextItems}
        kicker={t("home.kicker")}
        titleHtml={t("home.title")}
        intro={t("home.intro")}
        primaryHref={article ? `#/article/${encodeURIComponent(article.slug)}` : "#/archive"}
        primaryLabel={article ? t("home.latest") : t("home.archive")}
        secondaryHref="#/gallery"
        secondaryLabel={t("home.gallery")}
      />
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
