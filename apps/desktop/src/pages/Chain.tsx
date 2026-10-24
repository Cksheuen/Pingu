import { useRuntimeOperation } from "../lib/runtime-operation";
import { Menu } from "../components/Menu";
import { Skeleton } from "../components/Skeleton";
import type { CSSProperties } from "react";
import Toast from "../components/Toast";
import ChainMeasurements from "../components/ChainMeasurements";
import Select from "../components/Select";
import { useLiveResource } from "../hooks/useLiveResource";
import Tooltip from "../components/Tooltip";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { NetworkError } from "../components/network/NetworkState";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { t } from "../lib/i18n";
import { useConnectionStore } from "../lib/connection-store";
import { errorMessage } from "../lib/network-view";
import {
  getProxyChain,
  getChainRuntime,
  saveProxyChain,
  compareProxyChain,
  cancelChainComparison,
  nodeKey,
  autoSelectChain,
  getChainProgress,
  type ChainSelection,
  type ChainSnapshot,
  type ChainSettings,
  type ChainComparison,
  type ChainNodeRef
} from "../lib/chain-api";

export default function Chain({ onRouteChange }: { onRouteChange?: (key: string) => void; }) {
  useI18nRerender();
  const [snapshot, setSnapshot] = useState<ChainSnapshot | null>(null);
  const [draft, setDraft] = useState<ChainSettings>({ enabled: false, entry: null, exit: null });
  const [selection, setSelection] = useState<ChainSelection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const [result, setResult] = useState<ChainComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "test" | "auto" | null>("load");
  const [cancelling, setCancelling] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const refreshStatus = useConnectionStore(s => s.refreshStatus);
  const operation = useRuntimeOperation(s => s.command);
  const connected = useConnectionStore(s => s.status.connected);
  const load = async () => {
    setBusy("load");
    setError(null);
    try {
      const data = await getProxyChain();
      if (!mounted.current) return;
      setSnapshot(data);
      const exit = data.settings.exit
        ?? data.choices.find(c => c.reference.kind === "manual" && !c.unavailable_reason)?.reference
        ?? null;
      setDraft({ ...data.settings, exit });
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  useEffect(
    () => {
      mounted.current = true;
      void load();
      return () => {
        mounted.current = false;
        if (running.current) void cancelChainComparison().catch(() => { });
      };
    },
    []
  );
  const runtime = useLiveResource(getChainRuntime, connected && !!snapshot?.settings.enabled, 3000);
  const progress = useLiveResource(getChainProgress, (busy === "auto" || busy === "test"), 1000);
  const runtimeRoute = runtime.error ? "unknown" : runtime.data?.route ?? "checking";
  const routeKey = !snapshot?.settings.enabled
    ? ""
    : `${runtimeRoute}:${nodeKey(snapshot.settings.entry)}:${nodeKey(snapshot.settings.exit)}`;
  useEffect(() => { onRouteChange?.(routeKey); }, [onRouteChange, routeKey]);
  const choices = snapshot?.choices ?? [];
  const selected = (side: "entry" | "exit") => choices.find(c => nodeKey(c.reference) === nodeKey(draft[side]));
  const valid = !!selected("entry") && !!selected("exit") && nodeKey(draft.entry) !== nodeKey(draft.exit)
    && !selected("entry")?.unavailable_reason
    && !selected("exit")?.unavailable_reason;
  const changed = nodeKey(draft.entry) !== nodeKey(snapshot?.settings.entry ?? null)
    || nodeKey(draft.exit) !== nodeKey(snapshot?.settings.exit ?? null);
  const save = async (enabled: boolean, singleExit = false) => {
    if (busy || operation) return;
    setBusy("save");
    setError(null);
    try {
      await saveProxyChain(
        singleExit
          ? { ...draft, enabled: false }
          : enabled ? { ...draft, enabled: true } : { ...snapshot!.settings, enabled: false },
        singleExit
      );
      await load();
      await refreshStatus();
      await runtime.refresh();
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const test = async () => {
    if (busy || !valid) return;
    setBusy("test");
    setError(null);
    setResult(null);
    setSelection(null);
    setCancelling(false);
    running.current = true;
    try {
      const value = await compareProxyChain(draft);
      if (mounted.current) setResult(value);
    }
    catch (e) {
      if (mounted.current) setError(errorMessage(e));
    }
    finally {
      running.current = false;
      if (mounted.current) {
        setBusy(null);
        setCancelling(false);
      }
    }
  };
  const auto = async () => {
    if (busy || !draft.exit || selected("exit")?.unavailable_reason) return;
    setBusy("auto");
    setError(null);
    setResult(null);
    setSelection(null);
    setToast(null);
    setCancelling(false);
    running.current = true;
    try {
      const next = await autoSelectChain(draft.exit);
      if (!mounted.current) return;
      setSelection(next);
      if (next.applied) {
        await load();
        await refreshStatus();
        await runtime.refresh();
      }
      if (mounted.current) setToast(t(`chain.toast_${next.outcome}`));
    } catch (e) {
      if (mounted.current) {
        setError(errorMessage(e));
        setToast(t("chain.toast_error"));
      }
    }
    finally {
      running.current = false;
      if (mounted.current) {
        setBusy(null);
        setCancelling(false);
      }
    }
  };
  const nameOf = (reference: ChainNodeRef | null) =>
    choices.find(choice => nodeKey(choice.reference) === nodeKey(reference))?.name;
  const actionsDisabled = !!operation || !!busy;
  const exitDisabled = actionsDisabled || !selected("exit") || !!selected("exit")?.unavailable_reason;
  const pairDisabled = actionsDisabled || !valid;
  const autoDisabled = exitDisabled
    || !choices.some(choice => choice.reference.kind === "subscription" && !choice.unavailable_reason);
  const statusLabel = snapshot?.settings.enabled
    ? connected
      ? t(
        runtime.error
          ? "chain.runtime_stale"
          : `chain.runtime_${runtime.data?.route ?? "checking"}`
      )
      : t("chain.next_connect")
    : t("route.disabled");
  const actualSingle = runtime.data?.route === "entry"
    ? snapshot?.settings.entry
    : runtime.data?.route === "exit" ? snapshot?.settings.exit : null;
  const singleRoute = runtime.data?.route === "entry" || runtime.data?.route === "exit";
  const liveRouteLabel = runtime.error
    ? t("chain.runtime_stale")
    : runtime.data?.route === "chain"
      ? `${nameOf(snapshot?.settings.entry ?? null) ?? "—"} → ${nameOf(snapshot?.settings.exit ?? null) ?? "—"}`
      : singleRoute
        ? nameOf(actualSingle ?? null)
        : t(`chain.runtime_${runtime.data?.route ?? "checking"}`);
  const progressLabel = cancelling
    ? t("chain.cancelling")
    : busy === "auto" && progress.data?.applying
      ? t("network.saving")
      : busy === "auto"
        ? `${t("chain.auto_running")} ${progress.data?.completed ?? 0}/${progress.data?.total || "—"}`
        : t("chain.progress");

  return (
    <div className="chain-workspace">
      <Toast message={toast} onClose={dismissToast} />
      <NetworkError error={error} onRetry={!snapshot ? () => void load() : undefined} />
      {!snapshot
        ? busy ? <div className="surface chain-card"><Skeleton height={32} lines={3} /></div> : null
        : (
          <>
            <section className="surface chain-card" aria-label={t("chain.route")}>
              <div className="chain-heading">
                <h2 className="section-title">{t("nav.chain")} <Tooltip text={t("chain.routing_note")} /></h2>
                <div className="chain-heading-status">
                  <span className="pill" data-enabled={snapshot.settings.enabled}>{statusLabel}</span>
                  {snapshot.settings.enabled && connected
                    && (
                      <div
                        className="chain-live-route"
                        role="status"
                        data-fallback={singleRoute}
                      >
                        <span>{t("chain.actual_route")}</span>
                        <strong>
                          {liveRouteLabel}
                        </strong>
                        <span title={t("chain.failover_detail")}>{t("chain.auto_fallback")}</span>
                      </div>
                    )}
                </div>
              </div>
              {choices.length === 0
                ? (
                  <div className="chain-empty-state">
                    <span>{t("workspace.no_nodes")}</span>
                    <Link className="btn btn-primary" to="/sources">{t("route.add_source")}</Link>
                  </div>
                )
                : (
                  <>
                    {snapshot.settings.enabled && changed
                      && (
                        <p className="network-hint">
                          {t("chain.saved_route")}
                          {": "}
                          {nameOf(snapshot.settings.entry) ?? "—"}
                          {" → "}
                          {nameOf(snapshot.settings.exit) ?? "—"}
                        </p>
                      )}
                    <div className="chain-path">
                      <span className="chain-endpoint">{t("chain.device")}</span>
                      <span aria-hidden="true">→</span>
                      {(["entry", "exit"] as const).map(
                        (side, i) =>
                        (
                          <Fragment key={side}>
                            {i > 0 && (
                              <button
                                className="btn btn-icon btn-ghost chain-swap"
                                aria-label={t("chain.swap")}
                                title={t("chain.swap")}
                                disabled={pairDisabled}
                                onClick={() => {
                                  setDraft(d => ({ ...d, entry: d.exit, exit: d.entry }));
                                  setResult(null);
                                  setSelection(null);
                                }}
                              >⇄</button>
                            )}
                            <div className="chain-node">
                              <label htmlFor={`chain-${side}`}>{t(`chain.${side}`)}</label>
                              <Select
                                id={`chain-${side}`}
                                label={t(`chain.${side}`)}
                                value={nodeKey(draft[side])}
                                disabled={actionsDisabled}
                                searchable
                                options={[
                                  ...(side === "entry" ? [{ value: "", label: t("chain.no_entry") }] : []),
                                  ...choices.map(
                                    c =>
                                    ({
                                      value: nodeKey(c.reference),
                                      label: c.name,
                                      group: c.reference.kind === "manual" ? t("workspace.manual_nodes") : c.source,
                                      detail: c.unavailable_reason ? t("chain.unsupported") : c.protocol.toUpperCase(),
                                      disabled: !!c.unavailable_reason
                                        || nodeKey(c.reference) === nodeKey(draft[side === "entry" ? "exit" : "entry"])
                                    })
                                  )
                                ]}
                                onChange={value => {
                                  const choice = choices.find(c => nodeKey(c.reference) === value);
                                  setDraft(d => ({ ...d, [side]: choice?.reference ?? null }));
                                  setResult(null);
                                  setSelection(null);
                                }}
                              />
                            </div>
                          </Fragment>
                        )
                      )}
                      <span aria-hidden="true">→</span>
                      <span className="chain-endpoint">{t("chain.website")}</span>
                    </div>
                    <div className="network-actions chain-actions">
                      <button
                        className="btn btn-primary"
                        disabled={draft.entry ? pairDisabled || (snapshot.settings.enabled && !changed) : exitDisabled}
                        aria-busy={busy === "save"}
                        onClick={() => void save(!!draft.entry, !draft.entry)}
                      >
                        {busy === "save" && <span className="route-spinner" aria-hidden="true" />}
                        {t(draft.entry ? "chain.enable" : "chain.use_exit")}
                      </button>
                      <button className="btn" disabled={pairDisabled} onClick={() => void test()}>
                        {busy === "test" && <span className="route-spinner" aria-hidden="true" />}
                        {t("chain.test")}
                      </button>
                      <Menu label={t("route.chain_actions")} items={[
                        { label: t("chain.use_exit"), disabled: exitDisabled, onSelect: () => void save(false, true) },
                        { label: t("chain.auto_select"), disabled: autoDisabled, onSelect: () => void auto() },
                        ...(snapshot.settings.enabled ? [{
                          label: t("chain.disable"), disabled: actionsDisabled, onSelect: () => void save(false)
                        }] : [])
                      ]} />
                    </div>
                    {changed && snapshot.settings.enabled && <p className="network-hint">{t("chain.draft_note")}</p>}
                    <div className="chain-comparison" aria-label={t("chain.compare")}>
                      <div className="chain-heading">
                        <span className="chain-measure-label">
                          {t("chain.compare")}
                          {" "}
                          <span title={t("chain.test_desc")}>YouTube · GitHub</span>
                        </span>
                      </div>
                      {(busy === "test" || busy === "auto")
                        && (
                          <div className="chain-progress" role="status">
                            <div className="chain-progress-meter">
                              <span>{progressLabel}</span>
                              <div
                                className="progress"
                                role="progressbar"
                                aria-label={t("chain.compare")}
                                aria-valuemin={0}
                                aria-valuemax={progress.data?.running && progress.data.total > 0
                                  ? progress.data.total : undefined}
                                aria-valuenow={progress.data?.running && progress.data.total > 0
                                  ? progress.data.completed : undefined}
                                data-indeterminate={!progress.data?.running || !progress.data.total}
                                style={{ "--value": `${100 * (progress.data?.completed ?? 0)
                                  / (progress.data?.total || 1)}%` } as CSSProperties}
                              />
                            </div>
                            <button
                              className="btn btn-ghost"
                              disabled={cancelling || (busy === "auto" && !!progress.data?.applying)}
                              onClick={() => {
                                setCancelling(true);
                                void cancelChainComparison().then(accepted => { if (accepted === false) setCancelling(false); }).catch(
                                  e => {
                                    setError(errorMessage(e));
                                    setCancelling(false);
                                  }
                                );
                              }}
                            >
                              {t("network.cancel")}
                            </button>
                          </div>
                        )}
                      <ChainMeasurements comparison={result} selection={selection} />
                    </div>
                  </>
                )}
            </section>
          </>
        )}
    </div>
  );
}
