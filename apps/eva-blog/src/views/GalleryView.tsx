import { useLocale } from "../hooks/useLocale";
import { ArtworkCard, ArtworkImage } from "../components/ArtworkCard";
import { EmptyState } from "../components/EmptyState";
import { HeroSection } from "../components/HeroSection";
import type { PublicArtwork } from "../types";
import type { HeroProps } from "../hooks/heroTypes";

interface GalleryViewProps extends HeroProps {
  artworks: PublicArtwork[];
  artworkSlug: string | null;
  loading: boolean;
}

export function GalleryView({ artworks, artworkSlug, loading, heroRef, heroTabRefs, heroTextItems }: GalleryViewProps) {
  const { t, formatDate } = useLocale();

  if (artworkSlug) {
    const artwork = artworks.find((item) => item.slug === artworkSlug);
    if (!artwork) {
      return <EmptyState text={loading ? t("gallery.opening") : t("gallery.unavailable")} />;
    }
    return (
      <section className="artwork-detail route-enter">
        <a className="reader-crumb" href="#/gallery">{t("gallery.back")}</a>
        <div className="artwork-detail-grid">
          <ArtworkImage artwork={artwork} className="artwork-detail-image" />
          <div className="artwork-detail-copy">
            <p className="eyebrow">{artwork.medium || t("gallery.visualStudy")} / {formatDate(artwork.publishedAt)}</p>
            <h1>{artwork.title}</h1>
            <p className="artwork-caption">{artwork.caption || ""}</p>
            <div className="artist-note">
              <span className="eyebrow">{t("gallery.artistNote")}</span>
              <p>{artwork.artistNote || t("gallery.fallbackNote")}</p>
            </div>
            <div className="card-footer">
              <span>{artwork.license || t("gallery.rights")}</span>
              {artwork.relatedArticleSlug && (
                <a href={`#/article/${encodeURIComponent(artwork.relatedArticleSlug)}`}>{t("gallery.related")}</a>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
      <HeroSection
        heroRef={heroRef}
        heroTabRefs={heroTabRefs}
        heroTextItems={heroTextItems}
        kicker={t("gallery.kicker")}
        titleHtml={t("gallery.title")}
        intro={t("gallery.intro")}
        primaryHref="#/archive"
        primaryLabel={t("gallery.heroCta")}
        secondaryHref="#/now"
        secondaryLabel={t("gallery.heroCtaSecondary")}
      />
      <section className="gallery-view route-enter">
        <div className="gallery-grid">
          {artworks.length ? (
            artworks.map((artwork, index) => (
              <ArtworkCard key={artwork.id} artwork={artwork} variant={index === 0 ? "gallery-feature" : ""} />
            ))
          ) : (
            <EmptyState text={t("gallery.empty")} />
          )}
        </div>
      </section>
    </>
  );
}
