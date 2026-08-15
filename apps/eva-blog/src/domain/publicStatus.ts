import type { PublicStatus } from "../types";

type StatusLike = {
  isPublic?: boolean;
  expiresAt?: string | null;
  updatedAt?: string;
};

export function listPublicStatuses<T extends StatusLike>(statuses: T[], limit: number = 5, now: string = new Date().toISOString()): T[] {
  return [...statuses]
    .filter((status) => status.isPublic && (!status.expiresAt || String(status.expiresAt).localeCompare(String(now)) > 0))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

type DescribableStatus = {
  kind?: string;
  title?: string;
  details?: string;
  meta?: {
    playing?: boolean;
    track?: string;
    artist?: string;
    usagePercent?: number;
    usedTokens?: number;
    limitTokens?: number;
    unit?: string;
  };
};

export function describeStatus(status: DescribableStatus | null | undefined): string {
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

function formatTokenUsage(meta: DescribableStatus["meta"], fallback?: string): string {
  if (meta?.usagePercent !== undefined) return `${meta.usagePercent}%`;
  if (!meta?.usedTokens && meta?.usedTokens !== 0) return fallback || "";
  const used = formatCount(meta.usedTokens);
  const limit = meta.limitTokens === undefined ? "" : ` / ${formatCount(meta.limitTokens)}`;
  return `${used}${limit} ${meta.unit || "tokens"}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export type { PublicStatus };
