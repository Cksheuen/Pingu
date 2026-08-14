export const STATUS_KINDS = Object.freeze(["work", "song", "activity", "token"]);

export function normalizeStatus(input, session, options = {}) {
  if (!session?.login) {
    throw new Error("A signed-in user is required to sync status.");
  }

  const kind = STATUS_KINDS.includes(input.kind) ? input.kind : "activity";
  const meta = options.safeAuto ? normalizeAutoStatusMeta(kind, input) : normalizeStatusMeta(kind, input);
  const title = options.safeAuto
    ? kind === "token" ? "Token usage" : meta.track
    : normalizeStatusTitle(kind, input, meta);
  if (!title) {
    throw new Error("Status title is required.");
  }

  const now = options.now || new Date().toISOString();
  const expiresAt = normalizeExpiry(input.expiresAt, now);

  return {
    id: input.id || `status_${Date.parse(now).toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    title,
    details: options.safeAuto ? "" : String(input.details || "").trim(),
    source: options.safeAuto ? `auto:${kind === "song" ? "music" : "token"}` : String(input.source || "manual").trim(),
    isPublic: options.safeAuto ? false : kind === "token" ? input.isPublic === true : input.isPublic !== false,
    ...(options.safeAuto ? { syncKey: `auto:${kind === "song" ? "music" : "token"}` } : {}),
    ...(meta ? { meta } : {}),
    actor: {
      id: session.id,
      login: session.login,
      name: session.name || session.login
    },
    createdAt: input.createdAt || now,
    updatedAt: now,
    expiresAt
  };
}

export function listPublicStatuses(statuses, limit = 5, now = new Date().toISOString()) {
  return [...statuses]
    .filter((status) => status.isPublic && (!status.expiresAt || String(status.expiresAt).localeCompare(String(now)) > 0))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

function normalizeExpiry(value, now) {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time) || time <= Date.parse(now)) throw new Error("Status expiry must be a future timestamp.");
  return new Date(time).toISOString();
}

export function describeStatus(status) {
  if (!status) {
    return "No current status has been synced.";
  }
  const kindLabel = status.kind === "song"
    ? status.meta?.playing === false ? "Paused" : "Listening"
    : status.kind === "work"
      ? "Working"
      : status.kind === "token"
        ? "Token usage"
        : "Active";
  const title = status.kind === "song"
    ? [status.meta?.track || status.title, status.meta?.artist].filter(Boolean).join(" · ")
    : status.kind === "token"
      ? formatTokenUsage(status.meta, status.title)
      : status.title;
  return `${kindLabel}: ${title}${status.details ? ` - ${status.details}` : ""}`;
}

function normalizeStatusTitle(kind, input, meta) {
  const title = String(input.title || "").trim();
  if (title) return title;
  if (kind === "song") return meta?.track || "";
  if (kind === "token") return "Token usage";
  return "";
}

function normalizeStatusMeta(kind, input) {
  const raw = input.meta && typeof input.meta === "object" ? input.meta : {};
  if (kind === "song") {
    const track = String(input.track ?? raw.track ?? input.title ?? "").trim();
    if (!track) throw new Error("A track name is required for music status.");
    return compact({
      track,
      artist: input.artist ?? raw.artist,
      album: input.album ?? raw.album,
      service: input.service ?? raw.service,
      url: input.url ?? raw.url,
      artworkUrl: input.artworkUrl ?? raw.artworkUrl,
      playing: input.playing === undefined ? raw.playing !== false : input.playing !== false
    });
  }
  if (kind === "token") {
    const usedTokens = numberValue(input.usedTokens ?? raw.usedTokens);
    const limitTokens = numberValue(input.limitTokens ?? raw.limitTokens);
    if (usedTokens === null) throw new Error("Token usage requires usedTokens.");
    if (limitTokens !== null && limitTokens < usedTokens) throw new Error("Token limit must be greater than or equal to used tokens.");
    return compact({
      usedTokens,
      limitTokens,
      unit: String(input.unit ?? raw.unit ?? "tokens").trim(),
      provider: input.provider ?? raw.provider,
      model: input.model ?? raw.model,
      window: input.window ?? raw.window,
      resetAt: input.resetAt ?? raw.resetAt
    });
  }
  return null;
}

function normalizeAutoStatusMeta(kind, input) {
  const raw = input.meta && typeof input.meta === "object" ? input.meta : {};
  if (kind === "song") {
    const track = String(input.track || raw.track || input.title || "").trim();
    if (!track) throw new Error("Automatic music sync requires a track name.");
    return compact({
      track,
      artist: input.artist ?? raw.artist,
      service: input.service ?? raw.service,
      playing: input.playing === undefined ? raw.playing !== false : input.playing !== false
    });
  }
  if (kind === "token") {
    const usagePercent = numberValue(input.usagePercent ?? raw.usagePercent);
    if (usagePercent === null || usagePercent > 100) throw new Error("Automatic token sync requires a usage percentage between 0 and 100.");
    return { usagePercent, unit: "%" };
  }
  throw new Error("Background reporting only supports music and token signals.");
}

function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function formatTokenUsage(meta, fallback) {
  if (meta?.usagePercent !== undefined) return `${meta.usagePercent}%`;
  if (!meta?.usedTokens && meta?.usedTokens !== 0) return fallback;
  const used = formatCount(meta.usedTokens);
  const limit = meta.limitTokens === undefined ? "" : ` / ${formatCount(meta.limitTokens)}`;
  return `${used}${limit} ${meta.unit || "tokens"}`;
}

function formatCount(value) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
