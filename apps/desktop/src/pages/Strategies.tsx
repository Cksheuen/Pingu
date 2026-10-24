import { useRuntimeOperation } from "../lib/runtime-operation";
import Select from "../components/Select";
import { SectionHeader } from "../components/SectionHeader";
import { Skeleton } from "../components/Skeleton";
import { runOptimistic } from "../lib/optimistic";
import { useState } from "react";
import { Link } from "react-router-dom";
import { NetworkError } from "../components/network/NetworkState";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useLiveResource } from "../hooks/useLiveResource";
import { useConnectionStore } from "../lib/connection-store";
import { t } from "../lib/i18n";
import { listStrategyGroups, selectStrategyProxy, testStrategyDelay } from "../lib/mihomo-api";
import { errorMessage, strategyKind } from "../lib/network-view";

export default function Strategies() {
  useI18nRerender();
  const chainActive = useConnectionStore((state) => state.status.active_node_id === "__chain__");
  const operation = useRuntimeOperation(s => s.command);
  const connected = useConnectionStore((state) => state.status.connected);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: groups, error, loading, refresh } = useLiveResource(
    listStrategyGroups, true, 5000, !!operation || !!busy
  );
  const [pendingSelection, setPendingSelection] = useState<{ group: string; value: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [delays, setDelays] = useState<Record<string, number>>({});
  const run = async (name: string, action: () => Promise<void>) => {
    if (busy || operation) return;
    setBusy(name);
    setActionError(null);
    try {
      await action();
      await refresh();
      await useConnectionStore.getState().refreshAll();
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(null); }
  };
  const selectionDisabled = !!busy || !!operation || !!error || chainActive;

  return (
    <div className="workspace-section network-page">
      <SectionHeader title={t("nav.strategies")}>
        <button
          className="btn btn-ghost"
          disabled={loading || !!busy || !!operation}
          onClick={() => void refresh()}
        >
          {loading && <span className="route-spinner" aria-hidden="true" />}
          {t("network.refresh")}
        </button>
      </SectionHeader>
      {chainActive
        && (
          <p className="network-hint">{t("workspace.groups_paused")} <Link to="/route#chain">{t("nav.chain")} →</Link></p>
        )}
      {!connected && <p className="network-hint">{t("chain.next_connect")}</p>}
      <>
        <NetworkError
          error={actionError || error}
          onRetry={() => {
            setActionError(null);
            void refresh();
          }}
        />
        {error && groups && <p className="network-hint" role="status">{t("network.stale")}</p>}
        {!groups && loading
          ? <div className="strategy-grid"><Skeleton height={160} lines={2} /></div>
          : groups?.length === 0
            ? (
              <div className="surface empty-state">
                <h2 className="section-title">{t("strategies.empty")}</h2>
                <p>{t("strategies.empty_desc")}</p>
                <Link to="/sources" className="btn btn-primary">{t("route.add_source")}</Link>
              </div>
            )
            : (
              <div className="strategy-grid">
                {groups?.map(
                  (group) => {
                    const kind = strategyKind(group.type);
                    const current = pendingSelection?.group === group.name ? pendingSelection.value : group.now;
                    const measured = delays[group.name] ?? group.history[group.history.length - 1]?.delay;
                    return (
                      <article className="surface strategy-card" key={group.name}>
                        <div className="strategy-card-head">
                          <h2 title={group.name}>{group.name}</h2>
                          <span className="pill" data-kind={kind}>
                            {kind === "other" ? group.type : t(`strategies.${kind}`)}
                          </span>
                        </div>
                        <div className="strategy-current">
                          <span className="section-title">{t("strategies.current")}</span>
                          <strong title={current || undefined}>{current || t("strategies.no_selection")}</strong>
                          <span
                            className="strategy-latency"
                            data-tone={measured === undefined ? "muted" : measured <= 0 || measured >= 400
                              ? "warn" : measured < 150 ? "success" : "default"}
                          >
                            {measured
                              ? `${measured} ms`
                              : measured === 0 ? t("strategies.unreachable") : t("strategies.untested")}
                          </span>
                        </div>
                        {kind === "manual"
                          ? (
                            <label className="network-select-label">
                              {t("strategies.choose")}
                              <Select
                                label={t("strategies.choose")}
                                value={current ?? ""}
                                disabled={selectionDisabled}
                                searchable
                                options={group.all.map(name => ({ value: name, label: name }))}
                                placeholder={t("strategies.no_selection")}
                                onChange={value => {
                                  void run(group.name, () => runOptimistic({
                                    apply: () => setPendingSelection({ group: group.name, value }),
                                    commit: () => selectStrategyProxy(group.name, value),
                                    rollback: () => setPendingSelection(null)
                                  })).finally(() => setPendingSelection(null));
                                }}
                              />
                            </label>
                          ) : null}
                        <details className="strategy-members">
                          <summary>{group.all.length} {t("strategies.candidates")}</summary>
                          <ul>
                            {group.all.map(
                              (name) =>
                              (
                                <li key={name} data-active={current === name}>
                                  <span>{name}</span>
                                  {current === name && <span aria-label={t("strategies.current")}>✓</span>}
                                </li>
                              )
                            )}
                          </ul>
                        </details>
                        <div className="strategy-card-foot">
                          <span>
                            {kind === "manual"
                              ? `${group.all.length} ${t("strategies.candidates")}`
                              : t("strategies.managed_automatically")}
                          </span>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={!connected || selectionDisabled}
                            onClick={() =>
                              void run(
                                group.name,
                                async () => {
                                  const result = await testStrategyDelay(group.name);
                                  setDelays((current) => ({ ...current, [group.name]: result.delay }));
                                }
                              )}
                          >
                            {busy === group.name && <span className="route-spinner" aria-hidden="true" />}
                            {t("strategies.test")}
                          </button>
                        </div>
                      </article>
                    );
                  }
                )}
              </div>
            )}
      </>
    </div>
  );
}
