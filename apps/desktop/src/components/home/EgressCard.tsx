import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "../Modal";
import { NetworkError } from "../network/NetworkState";
import { useEgressStore } from "../../lib/egress-store";
import { configureVpsEgress, createCloudflareEgress, deleteCloudflareEgress, selectVpsEgress, renameCloudflareEgress, bindMagpieEgress, type CloudflareExit, type MagpieProvider, type MagpieTarget, type EgressManagement } from "../../lib/egress-api";
import { useRuntimeOperation } from "../../lib/runtime-operation";
import { useI18nRerender } from "../../hooks/useI18nRerender";
import { t } from "../../lib/i18n";

function ManagementDialog({ onClose }: { onClose: () => void }) {
  const { data, busy, error, execute } = useEgressStore();
  const [form, setForm] = useState<EgressManagement>(data?.management ?? { target: "", ssh_config: "", proxy_server: "" });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const management = { target: form.target.trim(), ssh_config: form.ssh_config.trim(), proxy_server: form.proxy_server.trim() };
    if (await execute(() => configureVpsEgress(management))) onClose();
  };
  return <Modal title={t("egress.management")} onClose={() => { if (!busy) onClose(); }}>
    <form className="network-form" onSubmit={event => void submit(event)}>
      <p className="network-hint">{t("egress.ssh_hint")}</p>
      <label>{t("egress.proxy_server")}<input className="dialog-field" value={form.proxy_server} placeholder="vps.example.com" required disabled={busy} maxLength={253} onChange={e => setForm({ ...form, proxy_server: e.target.value })} /></label>
      <label>{t("egress.ssh_target")}<input className="dialog-field" value={form.target} placeholder="root@203.0.113.10" required disabled={busy} maxLength={200} onChange={e => setForm({ ...form, target: e.target.value })} /></label>
      <label>{t("egress.ssh_config")}<input className="dialog-field" value={form.ssh_config} placeholder="/Users/you/.ssh/config" disabled={busy} onChange={e => setForm({ ...form, ssh_config: e.target.value })} /></label>
      <NetworkError error={error} />
      <div className="dialog-actions"><button type="button" className="action-secondary" disabled={busy} onClick={onClose}>{t("network.cancel")}</button><button className="action-primary" disabled={busy}>{busy ? t("network.saving") : t("network.save")}</button></div>
    </form>
  </Modal>;
}

function CreateDialog({ onClose, exit }: { onClose: () => void; exit?: CloudflareExit }) {
  const { busy, error, execute } = useEgressStore();
  const [name, setName] = useState(exit?.name ?? "Cloudflare");
  return <Modal title={t(exit ? "egress.rename" : "egress.create")} onClose={() => { if (!busy) onClose(); }}>
    <form className="network-form" onSubmit={event => { event.preventDefault(); void execute(() => exit ? renameCloudflareEgress(exit.id, name.trim()) : createCloudflareEgress(name.trim())).then(ok => { if (ok) onClose(); }); }}>
      {!exit && <p className="network-hint">{t("egress.create_hint")}</p>}
      <label>{t("egress.name")}<input className="dialog-field" maxLength={60} required disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
      {busy && <p className="network-hint" role="status">{t("egress.creating")}</p>}
      <NetworkError error={error} />
      <div className="dialog-actions"><button className="action-secondary" type="button" disabled={busy} onClick={onClose}>{t("network.cancel")}</button><button className="action-primary" disabled={busy || !name.trim()}>{t(exit ? "network.save" : "egress.create")}</button></div>
    </form>
  </Modal>;
}

function MagpieBinding({ provider, account, exits, disabled }: {
  provider: MagpieProvider; account: MagpieTarget; exits: CloudflareExit[]; disabled: boolean;
}) {
  const execute = useEgressStore(s => s.execute);
  const [choice, setChoice] = useState(account.selection);
  useEffect(() => setChoice(account.selection), [account.selection]);
  const missing = !["direct", "inherit", "external", ...exits.map(e => e.id)].includes(choice);
  const effective = exits.find(e => e.id === account.effective_exit)?.name;
  return <div className="magpie-binding">
    <div className="magpie-account"><strong>{account.name}</strong>
      <span className="network-hint">{account.kind === "key" ? "API Key" : t("egress.account")}{!account.enabled && ` · ${t("egress.disabled")}`}</span>
      {account.selection === "inherit" && <span className="network-hint">{t("egress.inherit")}{effective ? ` · ${effective}` : account.effective_direct ? ` · ${t("egress.direct")}` : ""}</span>}
    </div>
    <div className="magpie-binding-control">
      <select className="dialog-field" aria-label={`${provider.name} / ${account.name}`} value={choice}
        disabled={disabled} onChange={event => setChoice(event.target.value)}>
        <option value="direct">{t("egress.no_warp")}</option>
        <option value="inherit">{t("egress.inherit")}</option>
        {account.selection === "external" && <option value="external" disabled>{t("egress.external")}</option>}
        {missing && <option value={choice} disabled>{t("egress.missing")}</option>}
        {exits.map(exit => <option key={exit.id} value={exit.id} disabled={!exit.ready || !!provider.warning}>
          {exit.name}{!exit.ready ? ` · ${t("egress.unavailable")}` : ""}
        </option>)}
      </select>
      <button className="network-small-button" disabled={disabled || choice === account.selection || choice === "external" || missing}
        onClick={() => void execute(() => bindMagpieEgress(provider.id, account.ref, choice, provider.revision))}>
        {t("network.save")}
      </button>
    </div>
  </div>;
}

export function EgressCard() {
  useI18nRerender();
  const { data, error, loading, busy, refresh, execute } = useEgressStore();
  const operation = useRuntimeOperation(s => s.command);
  const revision = useRuntimeOperation(s => s.revision);
  const previousRevision = useRef(revision);
  const [dialog, setDialog] = useState<"management" | "create" | null>(null);
  const [edit, setEdit] = useState<{ kind: "rename" | "delete"; exit: CloudflareExit } | null>(null);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (previousRevision.current !== revision) { previousRevision.current = revision; void refresh(false); }
  }, [refresh, revision]);
  const disabled = busy || loading || !!operation;
  const exits = data?.exits ?? [];
  const providers = data?.magpie.providers ?? [];
  const bindings = (id: string) => Math.max(data?.magpie.references[id] ?? 0, providers.flatMap(p => p.targets).filter(a => a.effective_exit === id).length);
  return <section className="surface egress-card" aria-label={t("egress.title")}>
    <div className="egress-heading"><div><span className="section-label">{t("egress.title")}</span><p className="network-hint">{t("egress.subtitle")}</p></div><div className="network-actions">
      <button className="network-small-button" disabled={disabled} onClick={() => void refresh()}>{loading ? t("network.loading") : t("egress.refresh")}</button>
      <button className="network-small-button" disabled={disabled} onClick={() => setDialog("management")}>{t("egress.management")}</button>
    </div></div>
    <NetworkError error={error} />
    {!data?.management ? <div className="egress-empty"><p>{t("egress.setup_hint")}</p><button className="action-secondary" disabled={disabled} onClick={() => setDialog("management")}>{t("egress.setup")}</button></div> : <>
      <div className="egress-heading"><strong>{t("egress.pingu_exit")}</strong>
        <button className="action-primary" disabled={disabled || !data.installed || !!data.error} onClick={() => setDialog("create")}>{t("egress.create")}</button>
      </div>
      {data.selected !== "direct" && !exits.some(e => e.id === data.selected) && !loading && <p className="network-hint" role="status">{t("egress.selected_missing")}</p>}
      <div className="egress-options">
        <article className="egress-option" data-selected={data.selected === "direct"}>
          <div className="egress-option-title"><strong>{t("egress.direct")}</strong>{data.selected === "direct" && <span className="egress-selected">{t("egress.selected")}</span>}</div>
          <p className="network-hint">{data.management.proxy_server}</p>
          <p className="egress-description">{t("egress.direct_hint")}</p>
          <button className="action-secondary" disabled={disabled || data.selected === "direct"} onClick={() => void execute(() => selectVpsEgress("direct"))}>{t("egress.use_direct")}</button>
        </article>
        {exits.map(exit => <article key={exit.id} className="egress-option" data-selected={data.selected === exit.id}>
          <div className="egress-option-title"><strong>{exit.name}</strong>{data.selected === exit.id && <span className="egress-selected">{t("egress.selected")}</span>}</div>
          <p className="egress-address">{exit.ip ?? "—"}<span>{exit.location}</span></p>
          <p className="network-hint">{t(`egress.phase_${exit.phase}`)}{exit.phase === "ready" && !exit.ready ? ` · ${t("egress.unavailable")}` : ""}</p>
          <p className="egress-description">{t("egress.cloudflare_hint")}</p>
          <NetworkError error={exit.error ?? null} />
          <div className="network-actions">
            {exit.phase === "creating" ? <button className="action-secondary" disabled={disabled || exit.id === "legacy"} onClick={() => void execute(() => createCloudflareEgress(exit.name, exit.id))}>{t("egress.retry_create")}</button> :
              <button className="action-primary" disabled={disabled || !exit.ready || !data.eligible_proxy || data.selected === exit.id} onClick={() => void execute(() => selectVpsEgress(exit.id))}>{t("egress.use_cloudflare")}</button>}
            <button className="network-small-button" disabled={disabled} onClick={() => setEdit({ kind: "rename", exit })}>{t("egress.rename")}</button>
            <button className="network-small-button danger" disabled={disabled || bindings(exit.id) > 0 || !!data.magpie.error} onClick={() => setEdit({ kind: "delete", exit })}>{t("network.delete")}</button>
          </div>
          {bindings(exit.id) > 0 && <p className="network-hint">{t("egress.bound_count")} {bindings(exit.id)}</p>}
          {exit.checked_at && <p className="egress-checked">{t("egress.checked")} {new Date(exit.checked_at).toLocaleString()}</p>}
        </article>)}
      </div>
      {!data.installed && !data.error && <p className="network-hint">{t("egress.install_hint")}</p>}
      {!data.eligible_proxy && <p className="network-hint">{t("egress.select_node_hint")}</p>}
      <div className="magpie-egress">
        <div className="egress-heading"><div><strong>{t("egress.magpie_title")}</strong><p className="network-hint">{t("egress.magpie_hint")}</p></div></div>
        <NetworkError error={data.magpie.error} />
        {!data.magpie.available ? <p className="network-hint">{t("egress.magpie_unavailable")}</p> : <>
          {!providers.length && !data.magpie.error && <p className="network-hint">{t("egress.magpie_empty")}</p>}
          {providers.map(provider => <section key={provider.id} className="magpie-provider" aria-label={provider.name}>
            <h3>{provider.name}</h3>
            {provider.warning && <p className="network-hint">{t("egress.loopback_warning")}</p>}
            {provider.targets.map(account => <MagpieBinding key={account.ref} provider={provider} account={account} exits={exits} disabled={disabled || !!data.magpie.error} />)}
          </section>)}
          {data.magpie.web_url && <p className="network-hint">{t("egress.magpie_manage")} <span className="magpie-admin-address">{data.magpie.web_url}</span></p>}
        </>}
      </div>
      {busy && <p className="network-hint" role="status">{t("egress.working")}</p>}
    </>}
    {dialog === "management" && <ManagementDialog onClose={() => setDialog(null)} />}
    {dialog === "create" && <CreateDialog onClose={() => setDialog(null)} />}
    {edit?.kind === "rename" && <CreateDialog exit={edit.exit} onClose={() => setEdit(null)} />}
    {edit?.kind === "delete" && <Modal title={`${t("egress.delete_title")} · ${edit.exit.name}`} onClose={() => { if (!busy) setEdit(null); }}>
      <p className="network-hint">{t("egress.delete_hint")}</p><NetworkError error={error} />
      <div className="dialog-actions"><button className="action-secondary" disabled={busy} onClick={() => setEdit(null)}>{t("network.cancel")}</button><button className="action-primary danger-button" disabled={busy} onClick={() => void execute(() => deleteCloudflareEgress(edit.exit.id)).then(ok => { if (ok) setEdit(null); })}>{busy ? t("network.saving") : t("network.delete")}</button></div>
    </Modal>}
  </section>;
}
