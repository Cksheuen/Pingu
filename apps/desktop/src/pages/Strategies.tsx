import { useState } from "react";
import { Link } from "react-router-dom";
import { NetworkError, NetworkLoading, RuntimeOffline } from "../components/network/NetworkState";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useLiveResource } from "../hooks/useLiveResource";
import { useConnectionStore } from "../lib/connection-store";
import { t } from "../lib/i18n";
import { listStrategyGroups, selectStrategyProxy, testStrategyDelay } from "../lib/mihomo-api";
import { errorMessage, strategyKind } from "../lib/network-view";

export default function Strategies() {
  useI18nRerender();
  const connected = useConnectionStore((state) => state.status.connected);
  const { data: groups, error, loading, refresh } = useLiveResource(listStrategyGroups, connected, 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [delays, setDelays] = useState<Record<string, number>>({});
  const run = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name); setActionError(null);
    try { await action(); await refresh(); } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(null); }
  };
  return <div className="page-shell network-page"><header className="page-header"><div><p className="page-kicker">{t("strategies.kicker")}</p><h1 className="page-title">{t("nav.strategies")}</h1><p className="page-description">{t("strategies.desc")}</p></div><button className="action-secondary" disabled={!connected || loading || !!busy} onClick={() => void refresh()}>{loading ? t("network.updating") : t("network.refresh")}</button></header>
    {!connected ? <RuntimeOffline /> : <><NetworkError error={actionError || error} onRetry={() => { setActionError(null); void refresh(); }} />{error && groups && <p className="network-hint" role="status">{t("network.stale")}</p>}
      {!groups && loading ? <NetworkLoading /> : groups?.length === 0 ? <div className="surface empty-state"><h2>{t("strategies.empty")}</h2><p>{t("strategies.empty_desc")}</p><Link to="/subscriptions" className="action-primary">{t("nav.subscriptions")}</Link></div> : <div className="strategy-grid">{groups?.map((group) => {
        const kind = strategyKind(group.type);
        const measured = delays[group.name] ?? group.history[group.history.length - 1]?.delay;
        return <article className="surface strategy-card" key={group.name}>
          <div className="strategy-card-head"><h2 title={group.name}>{group.name}</h2><span className="network-badge" data-kind={kind}>{kind === "other" ? group.type : t(`strategies.${kind}`)}</span></div>
          <p className="network-hint strategy-description">{t(`strategies.${kind}_desc`)}</p>
          <div className="strategy-current"><span className="section-label">{t("strategies.current")}</span><strong title={group.now || undefined}>{group.now || t("strategies.no_selection")}</strong><span className="strategy-latency" data-available={!!measured}>{measured ? `${measured} ms` : measured === 0 ? t("strategies.unreachable") : t("strategies.untested")}</span></div>
          {kind === "manual" ? <label className="network-select-label">{t("strategies.choose")}<select className="network-select" value={group.now ?? ""} disabled={!!busy || !!error} onChange={(event) => void run(group.name, () => selectStrategyProxy(group.name, event.target.value))}><option value="" disabled>{t("strategies.no_selection")}</option>{group.all.map((name) => <option key={name} value={name}>{name}</option>)}</select></label> : <details className="strategy-members"><summary>{group.all.length} {t("strategies.candidates")}</summary><ul>{group.all.map((name) => <li key={name} data-active={group.now === name}><span>{name}</span>{group.now === name && <span aria-label={t("strategies.current")}>✓</span>}</li>)}</ul></details>}
          <div className="strategy-card-foot"><span>{kind === "manual" ? `${group.all.length} ${t("strategies.candidates")}` : t("strategies.managed_automatically")}</span><button className="network-small-button" disabled={!!busy || !!error} onClick={() => void run(group.name, async () => { const result = await testStrategyDelay(group.name); setDelays((current) => ({ ...current, [group.name]: result.delay })); })}>{busy === group.name ? t("network.working") : t("strategies.test")}</button></div>
        </article>;
      })}</div>}
      {groups && groups.length > 0 && <p className="network-hint">{t("strategies.switch_note")}</p>}
    </>}
  </div>;
}
