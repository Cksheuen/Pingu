import type { Artwork, PublicArtwork, PublicArtworkAsset } from "../types";

const PUBLIC_STATUSES = new Set(["published", "scheduled"]);

type ArtworkLike = {
  status?: string;
  publishedAt?: string | null;
  scheduledAt?: string | null;
  updatedAt?: string;
};

export function listPublishedArtworks<T extends ArtworkLike>(artworks: T[], options: { now?: string } = {}): T[] {
  const now = options.now || new Date().toISOString();
  return [...artworks]
    .filter((artwork) => PUBLIC_STATUSES.has(artwork.status ?? "") && (artwork.status === "published" || String(artwork.scheduledAt || "").localeCompare(String(now)) <= 0))
    .sort((left, right) => String(right.publishedAt || right.scheduledAt || right.updatedAt).localeCompare(String(left.publishedAt || left.scheduledAt || left.updatedAt)));
}

export function findArtworkBySlug<T extends { slug?: string }>(artworks: T[], slug: string): T | null {
  return artworks.find((artwork) => artwork.slug === slug) || null;
}

type ArtworkAssetLike = {
  id: string;
  altText?: string;
  width?: number | null;
  height?: number | null;
  ratio?: number | null;
  kind?: string;
  publicSrc?: string;
  publicThumbSrc?: string;
};

type ArtworkForPublic = ArtworkLike & {
  id: string;
  title: string;
  slug: string;
  caption?: string;
  artistNote?: string;
  altText?: string;
  medium?: string;
  dimensions?: { width: number; height: number } | null;
  tags?: string[];
  series?: string | null;
  relatedArticleSlug?: string;
  license?: string;
  assets?: ArtworkAssetLike[];
};

export function artworkToPublic(artwork: ArtworkForPublic, options: { publicBase?: string } = {}): PublicArtwork {
  const publicBase = options.publicBase || "/media/artworks";
  return {
    id: artwork.id,
    title: artwork.title,
    slug: artwork.slug,
    publishedAt: artwork.publishedAt || artwork.scheduledAt || undefined,
    caption: artwork.caption || "",
    artistNote: artwork.artistNote || "",
    altText: artwork.altText || "",
    medium: artwork.medium || "digital artwork",
    dimensions: artwork.dimensions || null,
    tags: artwork.tags || [],
    series: artwork.series || null,
    relatedArticleSlug: artwork.relatedArticleSlug || "",
    license: artwork.license || "All rights reserved",
    assets: (artwork.assets || []).map((asset): PublicArtworkAsset => ({
      id: asset.id,
      altText: asset.altText || artwork.altText || artwork.title,
      width: asset.width || null,
      height: asset.height || null,
      ratio: asset.ratio || null,
      kind: asset.kind || "image",
      src: asset.publicSrc || `${publicBase}/${encodeURIComponent(artwork.slug)}/${encodeURIComponent(asset.id)}?variant=display`,
      thumbSrc: asset.publicThumbSrc || `${publicBase}/${encodeURIComponent(artwork.slug)}/${encodeURIComponent(asset.id)}?variant=thumb`
    }))
  };
}

export type { Artwork };
