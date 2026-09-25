import { useMemo, useState } from "react";
import { Modal } from "../components/Modal";
import { NetworkError, NetworkLoading, RuntimeOffline } from "../components/network/NetworkState";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useLiveResource } from "../hooks/useLiveResource";
import { useConnectionStore } from "../lib/connection-store";
import { t } from "../lib/i18n";
import { closeAllConnections, closeConnection, listConnections } from "../lib/mihomo-api";
import { connectionDuration, errorMessage, filterConnections, formatBytes, type ConnectionSort } from "../lib/network-view";

export default function Connections() {
  useI18nRerender();
  const connected = useConnectionStore((state) => state.status.connected);
  const [paused, setPaused] = useState(false);
  const { data, error, loading, updatedAt, refresh } = useLiveResource(listConnections, connected, 2000, paused);
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState("all");
  const [sort, setSort] = useState<ConnectionSort>("traffic");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const connections = useMemo(() => filterConnections(data?.connections ?? [], query, network, sort), [data, query, network, sort]);
  const run = async (id: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(id); setActionError(null);
    try { await action(); setConfirmAll(false); await refresh(); }
    catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(null); }
  };
  return <div className="page-shell network-page"><header className="page-header"><div><p className="page-kicker">{t("connections.kicker")}</p><h1 className="page-title">{t("nav.connections")}</h1><p className="page-description">{t("connections.desc")}</p></div><div className="network-actions"><button className="action-secondary" disabled={!connected} onClick={() => setPaused((value) => !value)} aria-pressed={paused}>{paused ? t("connections.resume") : t("connections.pause")}</button><button className="action-secondary danger" disabled={!connected || !!busy || !data?.connections.length || !!error} onClick={() => { setActionError(null); setConfirmAll(true); }}>{t("connections.close_all")}</button></div></header>
    {!connected ? <RuntimeOffline /> : <><div className="network-metrics connections-metrics"><div><span>{t("connections.active")}</span><strong>{data ? data.connections.length : "—"}</strong></div><div><span>↓ {t("connections.download_total")}</span><strong>{data ? formatBytes(data.download_total) : "—"}</strong></div><div><span>↑ {t("connections.upload_total")}</span><strong>{data ? formatBytes(data.upload_total) : "—"}</strong></div></div>
      <div className="connections-toolbar"><label className="connections-search"><span className="sr-only">{t("connections.search")}</span><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("connections.search")} /></label><select className="network-select" aria-label={t("connections.protocol")} value={network} onChange={(event) => setNetwork(event.target.value)}><option value="all">{t("connections.all_protocols")}</option><option value="tcp">TCP</option><option value="udp">UDP</option></select><select className="network-select" aria-label={t("connections.sort")} value={sort} onChange={(event) => setSort(event.target.value as ConnectionSort)}><option value="traffic">{t("connections.sort_traffic")}</option><option value="recent">{t("connections.sort_recent")}</option></select></div>
      <div className="connections-live-state" role="status"><span className="network-badge" data-kind={!error && !paused ? "live" : "other"}>{error ? t("connections.stale") : paused ? t("connections.paused") : t("connections.live")}</span><span>{data ? `${connections.length} / ${data.connections.length}` : t("network.loading")}{updatedAt ? ` · ${t("connections.updated")} ${new Date(updatedAt).toLocaleTimeString()}` : ""}</span><button className="network-small-button" disabled={loading || !!busy} onClick={() => void refresh()}>{t("network.refresh")}</button></div>
      <NetworkError error={actionError || error} onRetry={() => { setActionError(null); void refresh(); }} />{error && data && <p className="network-hint">{t("network.stale")}</p>}
      {!data && loading ? <NetworkLoading /> : data && connections.length === 0 ? <div className="surface empty-state"><span className="network-empty-mark" aria-hidden="true">↔</span><h2>{data.connections.length ? t("connections.no_matches") : t("connections.empty")}</h2><p>{data.connections.length ? t("connections.no_matches_desc") : t("connections.empty_desc")}</p>{data.connections.length > 0 && <button className="action-secondary" onClick={() => { setQuery(""); setNetwork("all"); }}>{t("connections.clear_filters")}</button>}</div> : <div className="connection-list" aria-label={t("nav.connections")}>{connections.map((connection) => <article className="surface live-connection" key={connection.id}>
        <div className="live-connection-head"><div className="network-title-block"><h2 title={connection.host || connection.destination_ip}>{connection.host || connection.destination_ip || t("connections.unknown_destination")}{connection.destination_port && <span>:{connection.destination_port}</span>}</h2><p><span className="connection-protocol">{connection.network.toUpperCase() || "—"}</span> {connection.type || "—"}<span className="connection-meta-separator">·</span>{connection.process || t("connections.unknown_process")}</p></div><button className="network-small-button danger" disabled={!!busy || !!error} aria-label={`${t("connections.close")} ${connection.host || connection.destination_ip}`} onClick={() => void run(connection.id, () => closeConnection(connection.id))}>{busy === connection.id ? t("network.working") : t("connections.close")}</button></div>
        <div className="connection-route"><span>{t("connections.route")}</span><strong>{connection.chains.length ? connection.chains.join(" · ") : "—"}</strong></div>
        <div className="connection-bottom"><div className="connection-rule"><span>{t("connections.rule")}</span><strong title={`${connection.rule} ${connection.rule_payload}`}>{connection.rule || "—"}{connection.rule_payload ? ` · ${connection.rule_payload}` : ""}</strong></div><div className="connection-transfer"><span title={t("connections.download")}>↓ {formatBytes(connection.download)}</span><span title={t("connections.upload")}>↑ {formatBytes(connection.upload)}</span><span>{connectionDuration(connection.start, updatedAt ?? undefined)}</span></div></div>
        <details className="connection-details"><summary>{t("connections.details")}</summary><dl><div><dt>{t("connections.destination_ip")}</dt><dd>{connection.destination_ip || "—"}</dd></div><div><dt>{t("connections.source")}</dt><dd>{connection.source_ip || "—"}</dd></div><div><dt>{t("connections.started")}</dt><dd>{Number.isFinite(Date.parse(connection.start)) ? new Date(connection.start).toLocaleString() : "—"}</dd></div><div><dt>{t("connections.process")}</dt><dd>{connection.process || t("connections.unknown_process")}</dd></div></dl></details>
      </article>)}</div>}
    </>}
    {confirmAll && <Modal title={t("connections.close_all")} onClose={() => { if (!busy) setConfirmAll(false); }}><p className="network-hint">{t("connections.close_all_desc")}</p><NetworkError error={actionError} /><div className="dialog-actions"><button className="action-secondary" disabled={!!busy} onClick={() => setConfirmAll(false)}>{t("network.cancel")}</button><button className="action-primary danger-button" disabled={!!busy || !connected} onClick={() => void run("all", closeAllConnections)}>{busy ? t("network.working") : t("connections.close_all")}</button></div></Modal>}
  </div>;
}
