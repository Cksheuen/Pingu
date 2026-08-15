import { useLocale } from "../hooks/useLocale";
import { describeLocalizedStatus } from "../services/locale";
import { ArticleCard } from "../components/ArticleCard";
import { EmptyState } from "../components/EmptyState";
import { HomeHero } from "../components/HomeHero";
import type { PublicArticle, PublicArtwork, PublicStatus } from "../types";
import type { RefObject } from "react";
import type { MotionValue } from "framer-motion";
import type { HeroTextMotion } from "../hooks/useHeroMorph";

interface HomeViewProps {
  articles: PublicArticle[];
  artworks: PublicArtwork[];
  publicStatuses: PublicStatus[];
  loading: boolean;
  heroRef: RefObject<HTMLElement | null>;
  heroTabRefs: RefObject<(HTMLAnchorElement | null)[]>;
  heroTextItems: HeroTextMotion[];
}

export function HomeView({ articles, artworks, publicStatuses, loading, heroRef, heroTabRefs, heroTextItems }: HomeViewProps) {
  const { t, locale } = useLocale();
  const article = articles[0];

  return (
    <>
      <HomeHero
        article={article}
        heroRef={heroRef}
        heroTabRefs={heroTabRefs}
        heroTextItems={heroTextItems}
      />      <section className="home-ledger route-enter">
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
