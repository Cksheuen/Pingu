export function listPublicStatuses(statuses, limit = 5, now = new Date().toISOString()) {
  return [...statuses]
    .filter((status) => status.isPublic && (!status.expiresAt || String(status.expiresAt).localeCompare(String(now)) > 0))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

export function describeStatus(status) {
  if (!status) return "No current status has been synced.";
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
