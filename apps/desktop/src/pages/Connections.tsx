import { Menu } from "../components/Menu";
import Select from "../components/Select";
import { SectionHeader } from "../components/SectionHeader";
import { useMemo, useState } from "react";
import { Modal } from "../components/Modal";
import { NetworkError, NetworkLoading, RuntimeOffline } from "../components/network/NetworkState";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useLiveResource } from "../hooks/useLiveResource";
import { useConnectionStore } from "../lib/connection-store";
import { t } from "../lib/i18n";
import { closeAllConnections, closeConnection, listConnections } from "../lib/mihomo-api";
import {
  connectionDuration,
  errorMessage,
  filterConnections,
  formatBytes,
  type ConnectionSort
} from "../lib/network-view";

export default function Connections() {
  useI18nRerender();
  const connected = useConnectionStore((state) => state.status.connected);
  const [expanded, setExpanded] = useState<string | null>(null);
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
    setBusy(id);
    setActionError(null);
    try {
      await action();
      setConfirmAll(false);
      await refresh();
    }
    catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(null); }
  };
  return (
    <div className="workspace-section network-page">
      <SectionHeader title={t("nav.connections")}>
        <div className="network-actions">
          <button
            className="btn"
            disabled={!connected}
            onClick={() => setPaused((value) => !value)}
            aria-pressed={paused}
          >
            {paused ? t("connections.resume") : t("connections.pause")}
          </button>
          <Menu label={t("lists.actions")} items={[
            { label: t("connections.close_all"), tone: "danger",
              disabled: !connected || !!busy || !data?.connections.length || !!error,
              onSelect: () => { setActionError(null); setConfirmAll(true); } },
          ]} />
        </div>
      </SectionHeader>
      {!connected
        ? <RuntimeOffline />
        : (
          <>
            <div className="network-metrics connections-metrics">
              <div><span>{t("connections.active")}</span><strong>{data ? data.connections.length : "—"}</strong></div>
              <div>
                <span>↓ {t("connections.download_total")}</span>
                <strong>{data ? formatBytes(data.download_total) : "—"}</strong>
              </div>
              <div>
                <span>↑ {t("connections.upload_total")}</span>
                <strong>{data ? formatBytes(data.upload_total) : "—"}</strong>
              </div>
            </div>
            <div className="connections-toolbar">
              <label className="connections-search">
                <span className="sr-only">{t("connections.search")}</span>
                <span aria-hidden="true">⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("connections.search")}
                />
              </label>
              <Select
                label={t("connections.protocol")}
                value={network}
                onChange={setNetwork}
                options={[
                  { value: "all", label: t("connections.all_protocols") },
                  { value: "tcp", label: "TCP" },
                  { value: "udp", label: "UDP" }
                ]}
              />
              <Select
                label={t("connections.sort")}
                value={sort}
                onChange={value => setSort(value as ConnectionSort)}
                options={[
                  { value: "traffic", label: t("connections.sort_traffic") },
                  { value: "recent", label: t("connections.sort_recent") }
                ]}
              />
            </div>
            <div className="connections-live-state" role="status">
              <span className="pill" data-kind={!error && !paused ? "live" : "other"}>
                {error ? t("connections.stale") : paused ? t("connections.paused") : t("connections.live")}
              </span>
              <span>
                {data ? `${connections.length} / ${data.connections.length}` : t("network.loading")}
                {updatedAt
                  ? ` · ${t("connections.updated")} ${new Date(updatedAt).toLocaleTimeString()}`
                  : ""}
              </span>
              <button
                className="btn btn-sm"
                disabled={loading || !!busy}
                aria-busy={loading}
                onClick={() => void refresh()}
              >
                {t("network.refresh")}
              </button>
            </div>
            <NetworkError
              error={actionError || error}
              onRetry={() => {
                setActionError(null);
                void refresh();
              }}
            />
            {error && data && <p className="network-hint">{t("network.stale")}</p>}
            {!data && loading
              ? <NetworkLoading />
              : data && connections.length === 0
                ? (
                  <div className="surface empty-state">
                    <span className="network-empty-mark" aria-hidden="true">↔</span>
                    <h2 className="section-title">{data.connections.length ? t("connections.no_matches") : t("connections.empty")}</h2>
                    <p>{data.connections.length ? t("connections.no_matches_desc") : t("connections.empty_desc")}</p>
                    {data.connections.length > 0
                      ? (
                        <button
                          className="btn"
                          onClick={() => {
                            setQuery("");
                            setNetwork("all");
                          }}
                        >
                          {t("connections.clear_filters")}
                        </button>
                      ) : <button className="btn" onClick={() => void refresh()}>{t("network.refresh")}</button>}
                  </div>
                )
                : (
                  <div className="connection-list" aria-label={t("nav.connections")}>
                    {connections.map(
                      (connection) =>
                      (
                        <article className="live-connection" key={connection.id}>
                          <div className="row live-connection-head" role="button" tabIndex={0}
                            aria-expanded={expanded === connection.id}
                            onClick={() => setExpanded(expanded === connection.id ? null : connection.id)}
                            onKeyDown={event => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setExpanded(expanded === connection.id ? null : connection.id);
                              }
                            }}>
                            <div className="network-title-block">
                              <h2 title={connection.host || connection.destination_ip}>
                                {connection.host || connection.destination_ip || t("connections.unknown_destination")}
                                {connection.destination_port && <span>:{connection.destination_port}</span>}
                              </h2>
                              <p>
                                <span className="connection-protocol">{connection.network.toUpperCase() || "—"}</span>
                                {" "}
                                {connection.type || "—"}
                                <span className="connection-meta-separator">·</span>
                                {connection.process || t("connections.unknown_process")}
                              </p>
                            </div>
                            <div className="connection-route" title={[...connection.chains, connection.rule].join(" · ")}>
                              {connection.chains.join(" · ") || "—"}<br />{connection.rule || "—"}
                            </div>
                            <div className="connection-transfer">
                              <span title={t("connections.download")}>↓ {formatBytes(connection.download)}</span>
                              <span title={t("connections.upload")}>↑ {formatBytes(connection.upload)}</span>
                            </div>
                            <button
                              className="btn btn-icon btn-danger btn-ghost row-actions"
                              aria-busy={busy === connection.id}
                              disabled={!!busy || !!error}
                              aria-label={`${t("connections.close")} ${connection.host || connection.destination_ip}`}
                              onClick={event => { event.stopPropagation(); void run(connection.id, () => closeConnection(connection.id)); }}
                            >
                              <span aria-hidden="true">×</span>
                            </button>
                          </div>
                          <details className="connection-details" open={expanded === connection.id}>
                            <summary hidden aria-label={t("connections.details")}>
                              {connection.chains.length ? connection.chains.join(" · ") : t("connections.details")}
                            </summary>
                            <dl>
                              <div>
                                <dt>{t("connections.rule")}</dt>
                                <dd>{connection.rule || "—"}{connection.rule_payload ? ` · ${connection.rule_payload}` : ""}</dd>
                              </div>
                              <div>
                                <dt>{t("workspace.duration")}</dt>
                                <dd>{connectionDuration(connection.start, updatedAt ?? undefined)}</dd>
                              </div>
                              <div><dt>{t("connections.destination_ip")}</dt><dd>{connection.destination_ip || "—"}</dd></div>
                              <div><dt>{t("connections.source")}</dt><dd>{connection.source_ip || "—"}</dd></div>
                              <div>
                                <dt>{t("connections.started")}</dt>
                                <dd>
                                  {Number.isFinite(Date.parse(connection.start))
                                    ? new Date(connection.start).toLocaleString()
                                    : "—"}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("connections.process")}</dt>
                                <dd>{connection.process || t("connections.unknown_process")}</dd>
                              </div>
                            </dl>
                          </details>
                        </article>
                      )
                    )}
                  </div>
                )}
          </>
        )}
      {confirmAll
        && (
          <Modal title={t("connections.close_all")} onClose={() => { if (!busy) setConfirmAll(false); }}>
            <p className="network-hint">{t("connections.close_all_desc")}</p>
            <NetworkError error={actionError} />
            <div className="dialog-actions">
              <button className="btn" disabled={!!busy} onClick={() => setConfirmAll(false)}>
                {t("network.cancel")}
              </button>
              <button
                className="btn btn-danger"
                aria-busy={!!busy}
                disabled={!!busy || !connected}
                onClick={() => void run("all", closeAllConnections)}
              >
                {busy ? t("network.working") : t("connections.close_all")}
              </button>
            </div>
          </Modal>
        )}
    </div>
  );
}
