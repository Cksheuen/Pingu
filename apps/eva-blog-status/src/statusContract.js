export const STATUS_KINDS = Object.freeze(["work", "song", "activity", "token"]);

export function normalizeStatusInput(input = {}) {
  const kind = STATUS_KINDS.includes(input.kind) ? input.kind : "activity";
  const meta = normalizeStatusMeta(kind, input);
  const title = normalizeStatusTitle(kind, input, meta);
  if (!title) throw new Error("Status title is required.");
  return {
    kind,
    title,
    details: String(input.details || "").trim(),
    source: String(input.source || "local-device").trim(),
    isPublic: kind === "token" ? input.isPublic === true : input.isPublic !== false,
    ...(meta ? { meta } : {})
  };
}

export function normalizeAutoStatusInput(kind, signal = {}) {
  if (kind === "song") {
    const track = String(signal.track || "").trim();
    if (!track) throw new Error("Automatic music sync requires a track name.");
    return {
      kind: "song",
      title: track,
      details: "",
      source: "auto:music",
      isPublic: false,
      syncKey: "auto:music",
      meta: compact({
        track,
        artist: signal.artist,
        service: signal.service,
        playing: signal.playing !== false
      })
    };
  }
  if (kind === "token") {
    const usagePercent = numberValue(signal.usagePercent);
    if (usagePercent === null || usagePercent > 100) throw new Error("Automatic token sync requires a usage percentage between 0 and 100.");
    return {
      kind: "token",
      title: "Token usage",
      details: "",
      source: "auto:token",
      isPublic: false,
      syncKey: "auto:token",
      meta: { usagePercent, unit: "%" }
    };
  }
  throw new Error(`Background reporting does not support ${kind || "this"} status.`);
}

export function apiUrl(origin, path) {
  return new URL(path, origin).toString();
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

function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}
