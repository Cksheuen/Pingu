import type { LiveConnection } from "./mihomo-api.js";

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Request failed";
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

export function connectionDuration(start: string, now = Date.now()): string {
  const date = Date.parse(start);
  if (!Number.isFinite(date)) return "—";
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export type ConnectionSort = "traffic" | "recent";
export function filterConnections(connections: LiveConnection[], query: string, network: string, sort: ConnectionSort): LiveConnection[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return connections.filter((connection) => {
    if (network !== "all" && connection.network.toLowerCase() !== network) return false;
    const searchable = [connection.host, connection.destination_ip, connection.destination_port,
      connection.source_ip, connection.process, connection.type, connection.network,
      connection.rule, connection.rule_payload, ...connection.chains].join(" ").toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  }).sort((a, b) => sort === "traffic"
    ? (b.upload + b.download) - (a.upload + a.download)
    : (Date.parse(b.start) || 0) - (Date.parse(a.start) || 0));
}

export function strategyKind(type: string): "manual" | "auto" | "fallback" | "balance" | "other" {
  const normalized = type.toLowerCase().replace(/[-_]/g, "");
  if (normalized === "selector" || normalized === "select") return "manual";
  if (normalized === "urltest") return "auto";
  if (normalized === "fallback") return "fallback";
  if (normalized === "loadbalance") return "balance";
  return "other";
}
