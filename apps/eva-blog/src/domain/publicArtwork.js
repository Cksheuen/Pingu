const PUBLIC_STATUSES = new Set(["published", "scheduled"]);

export function listPublishedArtworks(artworks, options = {}) {
  const now = options.now || new Date().toISOString();
  return [...artworks]
    .filter((artwork) => PUBLIC_STATUSES.has(artwork.status) && (artwork.status === "published" || String(artwork.scheduledAt || "").localeCompare(String(now)) <= 0))
    .sort((left, right) => String(right.publishedAt || right.scheduledAt || right.updatedAt).localeCompare(String(left.publishedAt || left.scheduledAt || left.updatedAt)));
}

export function findArtworkBySlug(artworks, slug) {
  return artworks.find((artwork) => artwork.slug === slug) || null;
}

export function artworkToPublic(artwork, options = {}) {
  const publicBase = options.publicBase || "/media/artworks";
  return {
    id: artwork.id,
    title: artwork.title,
    slug: artwork.slug,
    publishedAt: artwork.publishedAt || artwork.scheduledAt,
    caption: artwork.caption || "",
    artistNote: artwork.artistNote || "",
    altText: artwork.altText || "",
    medium: artwork.medium || "digital artwork",
    dimensions: artwork.dimensions || null,
    tags: artwork.tags || [],
    series: artwork.series || null,
    relatedArticleSlug: artwork.relatedArticleSlug || "",
    license: artwork.license || "All rights reserved",
    assets: (artwork.assets || []).map((asset) => ({
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
