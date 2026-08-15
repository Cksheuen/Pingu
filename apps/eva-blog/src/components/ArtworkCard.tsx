import { useLocale } from "../hooks/useLocale";
import { ArtworkImage } from "./ArtworkImage";
import type { PublicArtwork } from "../types";

interface ArtworkCardProps {
  artwork: PublicArtwork;
  variant?: string;
}

export function ArtworkCard({ artwork, variant = "" }: ArtworkCardProps) {
  const { t, formatDate } = useLocale();
  return (
    <article className={`gallery-card ${variant}`}>
      <ArtworkImage artwork={artwork} className="gallery-card-image" />
      <div className="gallery-card-copy">
        <div>
          <p className="eyebrow">{artwork.medium || t("gallery.visualStudy")}</p>
          <h2>
            <a href={`#/gallery/${encodeURIComponent(artwork.slug)}`}>{artwork.title}</a>
          </h2>
        </div>
        <p>{artwork.caption || artwork.artistNote || t("gallery.fallbackNote")}</p>
        <div className="card-footer">
          <span>
            {artwork.dimensions ? `${artwork.dimensions.width} × ${artwork.dimensions.height}` : t("gallery.openStudy")}
          </span>
          <span>{formatDate(artwork.publishedAt)}</span>
        </div>
      </div>
    </article>
  );
}

export { ArtworkImage };
