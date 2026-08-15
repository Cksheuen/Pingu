import { useLocale } from "../hooks/useLocale";
import { ArtworkCard, ArtworkImage } from "../components/ArtworkCard";
import { EmptyState } from "../components/EmptyState";
import { RichText } from "../components/RichText";
import type { PublicArtwork } from "../types";

interface GalleryViewProps {
  artworks: PublicArtwork[];
  artworkSlug: string | null;
  loading: boolean;
}

export function GalleryView({ artworks, artworkSlug, loading }: GalleryViewProps) {
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
    <section className="gallery-view route-enter">
      <div className="gallery-intro">
        <div>
          <p className="eyebrow">{t("gallery.kicker")}</p>
          <h1><RichText html={t("gallery.title")} /></h1>
        </div>
        <p>{t("gallery.intro")}</p>
      </div>
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
  );
}
