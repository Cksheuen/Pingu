import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../components/Modal";
import { NetworkError, NetworkLoading } from "../components/network/NetworkState";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useConnectionStore } from "../lib/connection-store";
import { t, getLang } from "../lib/i18n";
import { deleteSubscription, importSubscription, refreshSubscription, updateSubscription, type SubscriptionSummary } from "../lib/mihomo-api";
import { errorMessage } from "../lib/network-view";
import { useSubscriptionStore } from "../lib/subscription-store";

// Must match MAX_BYTES in src-tauri/src/mihomo/profiles.rs, which fetches one
// byte past the limit and rejects the import server-side. The dialog and the
// backend both measure bytes, so pasted content is checked the same way.
const MAX_SUBSCRIPTION_BYTES = 4 * 1024 * 1024;

function ImportSubscriptionDialog({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oversized = new TextEncoder().encode(input).length > MAX_SUBSCRIPTION_BYTES;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || oversized || !name.trim() || !input.trim()) return;
    setBusy(true); setError(null);
    try { await importSubscription(name.trim(), input.trim()); await onImported(); onClose(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <Modal title={t("subscriptions.add")} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={(event) => void submit(event)} className="network-form">
      <p className="network-hint">{t("subscriptions.import_desc")}</p>
      <label>{t("subscriptions.name")}<input className="dialog-field" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("subscriptions.name_placeholder")} maxLength={100} required disabled={busy} /></label>
      <label>{t("subscriptions.content")}<textarea className="dialog-field subscription-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("subscriptions.input_placeholder")} rows={6} autoComplete="off" autoCapitalize="off" spellCheck={false} required disabled={busy} /></label>
      <label className="network-file-label">{t("subscriptions.from_file")}<input type="file" accept=".yaml,.yml,.txt,.conf" disabled={busy} onChange={async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setError(null);
        if (file.size > MAX_SUBSCRIPTION_BYTES) { setError(t("subscriptions.file_large")); return; }
        try { setInput(await file.text()); if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, "")); }
        catch (cause) { setError(errorMessage(cause)); }
      }} /></label>
      <NetworkError error={oversized ? t("subscriptions.file_large") : error} />
      <div className="dialog-actions"><button type="button" className="action-secondary" onClick={onClose} disabled={busy}>{t("network.cancel")}</button><button className="action-primary" disabled={busy || oversized || !input.trim() || !name.trim()}>{busy ? t("subscriptions.importing") : t("subscriptions.import")}</button></div>
    </form>
  </Modal>;
}

function RenameDialog({ source, onClose, onSave }: { source: SubscriptionSummary; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(source.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Modal title={t("subscriptions.rename")} onClose={() => { if (!busy) onClose(); }}><form className="network-form" onSubmit={async (event) => {
    event.preventDefault(); if (busy || !name.trim()) return; setBusy(true); setError(null);
    try { await onSave(name.trim()); onClose(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }}><label>{t("subscriptions.name")}<input className="dialog-field" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} disabled={busy} required /></label><NetworkError error={error} /><div className="dialog-actions"><button type="button" className="action-secondary" disabled={busy} onClick={onClose}>{t("network.cancel")}</button><button className="action-primary" disabled={busy || !name.trim()}>{busy ? t("network.saving") : t("network.save")}</button></div></form></Modal>;
}

export default function Subscriptions() {
  useI18nRerender();
  const { subscriptions, loading, loaded, error: loadError, refresh } = useSubscriptionStore();
  const connected = useConnectionStore((state) => state.status.connected);
  const refreshStatus = useConnectionStore((state) => state.refreshStatus);
  const [showImport, setShowImport] = useState(false);
  const [rename, setRename] = useState<SubscriptionSummary | null>(null);
  const [remove, setRemove] = useState<SubscriptionSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);

  const reload = async () => { await refresh(); await refreshStatus().catch(() => {}); };
  const run = async (key: string, action: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setBusy(key); setError(null);
    try { await action(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { await reload().catch(() => {}); lock.current = false; setBusy(null); }
  };
  const refreshAll = () => run("all", async () => {
    const failures: string[] = [];
    for (const source of subscriptions.filter((source) => source.source_kind === "url")) {
      try { await refreshSubscription(source.id); }
      catch (cause) { failures.push(`${source.name}: ${errorMessage(cause)}`); }
    }
    if (failures.length) throw new Error(failures.join(" · "));
  });
  const enabled = subscriptions.filter((source) => source.enabled);

  return <div className="page-shell network-page">
    <header className="page-header"><div><p className="page-kicker">{t("subscriptions.kicker")}</p><h1 className="page-title">{t("nav.subscriptions")}</h1><p className="page-description">{t("subscriptions.desc")}</p></div><div className="network-actions"><button className="action-secondary" onClick={() => void refreshAll()} disabled={!!busy || loading || !subscriptions.some((source) => source.source_kind === "url")}>{busy === "all" ? t("network.updating") : t("subscriptions.update_all")}</button><button className="action-primary" onClick={() => setShowImport(true)} disabled={!!busy}>+ {t("subscriptions.add")}</button></div></header>
    <div className="network-metrics"><div><span>{t("subscriptions.sources")}</span><strong>{loaded ? subscriptions.length : "—"}</strong></div><div><span>{t("subscriptions.enabled")}</span><strong>{loaded ? enabled.length : "—"}</strong></div><div><span>{t("subscriptions.nodes")}</span><strong>{loaded ? enabled.reduce((sum, source) => sum + source.proxy_count, 0) : "—"}</strong></div></div>
    <NetworkError error={error || loadError} onRetry={() => { setError(null); void refresh().catch(() => {}); }} />
    {loading && !loaded ? <NetworkLoading /> : !loaded ? null : subscriptions.length === 0 ? <div className="surface empty-state"><span className="network-empty-mark" aria-hidden="true">+</span><h2>{t("subscriptions.empty")}</h2><p>{t("subscriptions.empty_desc")}</p><button className="action-primary" onClick={() => setShowImport(true)}>{t("subscriptions.add")}</button><Link className="network-text-link" to="/nodes">{t("subscriptions.manual_nodes")}</Link></div> : <div className="subscription-list">{subscriptions.map((source) => <article className="surface subscription-card" key={source.id} data-enabled={source.enabled}>
      <div className="subscription-card-heading"><div className="network-title-block"><h2>{source.name}</h2><p>{source.source_kind === "url" ? source.source_host : t("subscriptions.local_source")}</p></div><label className="network-toggle"><input type="checkbox" checked={source.enabled} disabled={!!busy} onChange={(event) => void run(source.id, () => updateSubscription(source.id, { enabled: event.target.checked }))} /><span>{source.enabled ? t("subscriptions.enabled_state") : t("subscriptions.disabled_state")}</span></label></div>
      <div className="subscription-counts"><span><b>{source.proxy_count}</b> {t("subscriptions.nodes")}</span><span><b>{source.group_count}</b> {t("subscriptions.groups")}</span><span><b>{source.rule_count}</b> {t("subscriptions.rules")}</span></div>
      {source.last_error && <div className="network-error" role="status"><span>{t("subscriptions.last_good")} {source.last_error}</span></div>}
      {source.warnings.length > 0 && <details className="network-warnings"><summary>{t("subscriptions.warnings")} ({source.warnings.length})</summary><ul>{source.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="subscription-card-foot"><span>{t("subscriptions.updated")} {source.updated_at && Number.isFinite(Date.parse(source.updated_at)) ? new Date(source.updated_at).toLocaleString(getLang() === "zh" ? "zh-CN" : "en-US") : "—"}</span><div className="network-actions">{source.source_kind === "url" && <button className="network-small-button" disabled={!!busy} onClick={() => void run(source.id, () => refreshSubscription(source.id))}>{busy === source.id ? t("network.updating") : t("network.update")}</button>}<button className="network-small-button" disabled={!!busy} onClick={() => setRename(source)}>{t("subscriptions.rename")}</button><button className="network-small-button danger" disabled={!!busy} onClick={() => { setError(null); setRemove(source); }}>{t("network.delete")}</button></div></div>
    </article>)}</div>}
    {loaded && subscriptions.length > 0 && <p className="network-hint">{connected ? t("subscriptions.applies_live") : t("subscriptions.applies_connect")} <Link to="/strategies" className="network-text-link">{t("subscriptions.view_groups")} →</Link></p>}
    {showImport && <ImportSubscriptionDialog onClose={() => setShowImport(false)} onImported={reload} />}
    {rename && <RenameDialog source={rename} onClose={() => setRename(null)} onSave={async (name) => { await updateSubscription(rename.id, { name }); await reload(); }} />}
    {remove && <Modal title={t("subscriptions.remove_title")} onClose={() => { if (!busy) setRemove(null); }}><p className="network-hint">{t("subscriptions.remove_desc")} <strong>{remove.name}</strong></p><NetworkError error={error} /><div className="dialog-actions"><button className="action-secondary" disabled={!!busy} onClick={() => setRemove(null)}>{t("network.cancel")}</button><button className="action-primary danger-button" disabled={!!busy} onClick={() => void run(remove.id, async () => { await deleteSubscription(remove.id); setRemove(null); })}>{busy ? t("network.saving") : t("network.delete")}</button></div></Modal>}
  </div>;
}
