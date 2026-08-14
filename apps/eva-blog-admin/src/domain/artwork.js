export const ARTWORK_STATUSES = Object.freeze({
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  PUBLISHED: "published",
  UNPUBLISHED: "unpublished"
});

const PUBLIC_STATUSES = new Set([ARTWORK_STATUSES.PUBLISHED, ARTWORK_STATUSES.SCHEDULED]);

export function normalizeArtwork(input, options = {}) {
  const now = options.now || new Date().toISOString();
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Artwork title is required.");

  const assets = normalizeAssets(input.assets);
  const scheduledAt = normalizeTimestamp(input.scheduledAt, "Scheduled artwork time");
  const requestedStatus = Object.values(ARTWORK_STATUSES).includes(input.status)
    ? input.status
    : ARTWORK_STATUSES.DRAFT;
  const status = input.publish
    ? ARTWORK_STATUSES.PUBLISHED
    : scheduledAt && requestedStatus !== ARTWORK_STATUSES.UNPUBLISHED
      ? ARTWORK_STATUSES.SCHEDULED
      : requestedStatus;

  if (status === ARTWORK_STATUSES.PUBLISHED && assets.length === 0) {
    throw new Error("Published artwork requires at least one display asset.");
  }
  if (status === ARTWORK_STATUSES.SCHEDULED && !scheduledAt) {
    throw new Error("Scheduled artwork requires a publish time.");
  }

  const coverAssetId = String(input.coverAssetId || assets[0]?.id || "").trim();
  return {
    id: input.id || createId("artwork"),
    title,
    slug: createSlug(input.slug || title),
    status,
    scheduledAt: status === ARTWORK_STATUSES.SCHEDULED ? scheduledAt : null,
    publishedAt: status === ARTWORK_STATUSES.PUBLISHED ? input.publishedAt || now : input.publishedAt || null,
    unpublishedAt: status === ARTWORK_STATUSES.UNPUBLISHED ? normalizeTimestamp(input.unpublishedAt, "Unpublished artwork time") || now : null,
    createdAt: input.createdAt || now,
    updatedAt: now,
    caption: String(input.caption || "").trim().slice(0, 800),
    artistNote: String(input.artistNote || "").trim().slice(0, 4000),
    altText: String(input.altText || "").trim().slice(0, 300),
    medium: String(input.medium || "digital artwork").trim().slice(0, 120),
    dimensions: normalizeDimensions(input.dimensions),
    tags: normalizeTags(input.tags),
    series: normalizeSeries(input.series || (input.seriesTitle || input.seriesSlug ? input : null)),
    relatedArticleSlug: String(input.relatedArticleSlug || "").trim(),
    license: String(input.license || "All rights reserved").trim().slice(0, 160),
    coverAssetId,
    assets
  };
}

export function publishArtwork(artwork, options = {}) {
  const now = options.now || new Date().toISOString();
  if (!artwork.assets?.length) throw new Error("Artwork requires an asset before publishing.");
  return { ...artwork, status: ARTWORK_STATUSES.PUBLISHED, scheduledAt: null, publishedAt: artwork.publishedAt || now, unpublishedAt: null, updatedAt: now };
}

export function unpublishArtwork(artwork, options = {}) {
  const now = options.now || new Date().toISOString();
  return { ...artwork, status: ARTWORK_STATUSES.UNPUBLISHED, scheduledAt: null, unpublishedAt: now, updatedAt: now };
}

export function isArtworkPublic(artwork, now = new Date().toISOString()) {
  if (!artwork || !PUBLIC_STATUSES.has(artwork.status)) return false;
  return artwork.status === ARTWORK_STATUSES.PUBLISHED
    || Boolean(artwork.scheduledAt && String(artwork.scheduledAt).localeCompare(String(now)) <= 0);
}

export function listPublishedArtworks(artworks, options = {}) {
  const now = options.now || new Date().toISOString();
  return [...artworks]
    .filter((artwork) => isArtworkPublic(artwork, now))
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
    status: "published",
    publishedAt: artwork.publishedAt || artwork.scheduledAt,
    caption: artwork.caption,
    artistNote: artwork.artistNote,
    altText: artwork.altText,
    medium: artwork.medium,
    dimensions: artwork.dimensions,
    tags: artwork.tags,
    series: artwork.series,
    relatedArticleSlug: artwork.relatedArticleSlug,
    license: artwork.license,
    assets: (artwork.assets || []).map((asset) => ({
      id: asset.id,
      altText: asset.altText || artwork.altText,
      width: asset.width,
      height: asset.height,
      ratio: asset.ratio,
      kind: asset.kind,
      src: asset.publicSrc || publicBase + "/" + encodeURIComponent(artwork.slug) + "/" + encodeURIComponent(asset.id) + "?variant=display",
      thumbSrc: asset.publicThumbSrc || publicBase + "/" + encodeURIComponent(artwork.slug) + "/" + encodeURIComponent(asset.id) + "?variant=thumb"
    }))
  };
}

function normalizeAssets(value) {
  if (!Array.isArray(value)) return [];
  return value.map((asset) => {
    const width = positiveNumber(asset.width);
    const height = positiveNumber(asset.height);
    return {
      id: String(asset.id || createId("asset")),
      originalKey: String(asset.originalKey || "").trim(),
      displayKey: String(asset.displayKey || "").trim(),
      thumbKey: String(asset.thumbKey || "").trim(),
      publicSrc: String(asset.publicSrc || "").trim(),
      publicThumbSrc: String(asset.publicThumbSrc || "").trim(),
      altText: String(asset.altText || "").trim(),
      width,
      height,
      ratio: width && height ? Number((width / height).toFixed(4)) : null,
      mimeType: String(asset.mimeType || "image/webp").trim(),
      kind: String(asset.kind || "image").trim()
    };
  }).filter((asset) => asset.originalKey || asset.displayKey || asset.publicSrc);
}

function normalizeDimensions(value) {
  if (!value || typeof value !== "object") return null;
  const width = positiveNumber(value.width);
  const height = positiveNumber(value.height);
  return width && height ? { width, height } : null;
}

function normalizeSeries(value) {
  if (!value || typeof value !== "object") return null;
  const title = String(value.title || value.seriesTitle || "").trim();
  if (!title) return null;
  return { title, slug: createSlug(value.slug || value.seriesSlug || title), order: positiveNumber(value.order || value.seriesOrder) || 0 };
}

function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map(String).map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeTimestamp(value, label) {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(label + " is invalid.");
  return new Date(time).toISOString();
}

function createSlug(input) {
  const value = String(input || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return value || "artwork-" + Date.now().toString(36);
}

function createId(prefix) {
  const randomPart = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  return prefix + "_" + randomPart;
}
