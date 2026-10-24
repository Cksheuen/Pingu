import { useEffect, useRef, useState, type FormEvent } from "react";
import { Menu } from "../Menu";
import { Skeleton } from "../Skeleton";
import Select from "../Select";
import { runOptimistic } from "../../lib/optimistic";
import { Modal } from "../Modal";
import { NetworkError } from "../network/NetworkState";
import { useEgressStore } from "../../lib/egress-store";
import {
  configureVpsEgress,
  createCloudflareEgress,
  deleteCloudflareEgress,
  selectVpsEgress,
  renameCloudflareEgress,
  bindMagpieEgress,
  type CloudflareExit,
  type MagpieProvider,
  type MagpieTarget,
  type EgressManagement
} from "../../lib/egress-api";
import { useRuntimeOperation } from "../../lib/runtime-operation";
import { useI18nRerender } from "../../hooks/useI18nRerender";
import { t } from "../../lib/i18n";

function ManagementDialog({ onClose }: { onClose: () => void; }) {
  const { data, busy, error, execute } = useEgressStore();
  const [form, setForm] = useState<EgressManagement>(data?.management ?? { target: "", ssh_config: "", proxy_server: "" });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const management = {
      target: form.target.trim(),
      ssh_config: form.ssh_config.trim(),
      proxy_server: form.proxy_server.trim()
    };
    if (await execute(() => configureVpsEgress(management))) onClose();
  };
  return (
    <Modal title={t("egress.management")} onClose={() => { if (!busy) onClose(); }}>
      <form className="network-form" onSubmit={event => void submit(event)}>
        <p className="network-hint">{t("egress.ssh_hint")}</p>
        <label>
          {t("egress.proxy_server")}
          <input
            className="dialog-field"
            value={form.proxy_server}
            placeholder="vps.example.com"
            required
            disabled={busy}
            maxLength={253}
            onChange={e => setForm({ ...form, proxy_server: e.target.value })}
          />
        </label>
        <label>
          {t("egress.ssh_target")}
          <input
            className="dialog-field"
            value={form.target}
            placeholder="root@203.0.113.10"
            required
            disabled={busy}
            maxLength={200}
            onChange={e => setForm({ ...form, target: e.target.value })}
          />
        </label>
        <label>
          {t("egress.ssh_config")}
          <input
            className="dialog-field"
            value={form.ssh_config}
            placeholder="/Users/you/.ssh/config"
            disabled={busy}
            onChange={e => setForm({ ...form, ssh_config: e.target.value })}
          />
        </label>
        <NetworkError error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t("network.cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy}>{busy ? t("network.saving") : t("network.save")}</button>
        </div>
      </form>
    </Modal>
  );
}

function CreateDialog({ onClose, exit }: { onClose: () => void; exit?: CloudflareExit; }) {
  const { busy, error, execute } = useEgressStore();
  const [name, setName] = useState(exit?.name ?? "Cloudflare");
  return (
    <Modal
      title={t(exit ? "egress.rename" : "egress.create")}
      onClose={() => { if (!busy) onClose(); }}
    >
      <form
        className="network-form"
        onSubmit={event => {
          event.preventDefault();
          void execute(() => exit ? renameCloudflareEgress(exit.id, name.trim()) : createCloudflareEgress(name.trim())).then(
            ok => { if (ok) onClose(); }
          );
        }}
      >
        {!exit && <p className="network-hint">{t("egress.create_hint")}</p>}
        <label>
          {t("egress.name")}
          <input
            className="dialog-field"
            maxLength={60}
            required
            disabled={busy}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        {busy && <p className="network-hint" role="status">{t("egress.creating")}</p>}
        <NetworkError error={error} />
        <div className="dialog-actions">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>
            {t("network.cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            {t(exit ? "network.save" : "egress.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MagpieBinding(
  { provider, account, exits, disabled }: {
    provider: MagpieProvider;
    account: MagpieTarget;
    exits: CloudflareExit[];
    disabled: boolean;
  }
) {
  const execute = useEgressStore(s => s.execute);
  const [choice, setChoice] = useState(account.selection);
  const [saving, setSaving] = useState(false);
  useEffect(() => setChoice(account.selection), [account.selection]);
  const missing = !["direct", "inherit", "external", ...exits.map(e => e.id)].includes(choice);
  const effective = exits.find(e => e.id === account.effective_exit)?.name;
  return (
    <div className="row magpie-binding">
      <div className="magpie-account">
        <strong>{account.name}</strong>
        <span className="network-hint">
          {account.kind === "key" ? "API Key" : t("egress.account")}
          {!account.enabled && ` · ${t("egress.disabled")}`}
        </span>
        {account.selection === "inherit"
          && (
            <span className="network-hint">
              {t("egress.inherit")}
              {effective ? ` · ${effective}` : account.effective_direct ? ` · ${t("egress.direct")}` : ""}
            </span>
          )}
      </div>
      <div className="magpie-binding-control">
        <Select
          label={`${provider.name} / ${account.name}`}
          value={choice}
          disabled={disabled}
          onChange={setChoice}
          options={[
            { value: "direct", label: t("egress.no_warp") },
            { value: "inherit", label: t("egress.inherit") },
            ...(account.selection === "external"
              ? [{ value: "external", label: t("egress.external"), disabled: true }] : []),
            ...(missing ? [{ value: choice, label: t("egress.missing"), disabled: true }] : []),
            ...exits.map(exit => ({
              value: exit.id,
              label: exit.name,
              detail: !exit.ready ? t("egress.unavailable") : undefined,
              disabled: !exit.ready || !!provider.warning
            }))
          ]}
        />
        {choice !== account.selection && (
          <button
            className="btn btn-sm"
            disabled={disabled || choice === account.selection || choice === "external" || missing}
            onClick={() => {
              setSaving(true);
              void execute(() => bindMagpieEgress(provider.id, account.ref, choice, provider.revision))
                .finally(() => setSaving(false));
            }}
          >
            {saving && <span className="route-spinner" aria-hidden="true" />}
            {t("network.save")}
          </button>
        )}
      </div>
    </div>
  );
}

export function EgressCard() {
  useI18nRerender();
  const { data, error, loading, busy, refresh, execute } = useEgressStore();
  const operation = useRuntimeOperation(s => s.command);
  const revision = useRuntimeOperation(s => s.revision);
  const previousRevision = useRef(revision);
  const [dialog, setDialog] = useState<"management" | "create" | null>(null);
  const [edit, setEdit] = useState<{ kind: "rename" | "delete"; exit: CloudflareExit; } | null>(null);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(
    () => {
      if (previousRevision.current !== revision) {
        previousRevision.current = revision;
        void refresh(false);
      }
    },
    [refresh, revision]
  );
  const [optimisticExit, setOptimisticExit] = useState<string | null>(null);
  const selectedExit = optimisticExit ?? data?.selected;
  const disabled = busy || loading || !!operation;
  const selectExit = async (id: string) => {
    if (disabled) return;
    try {
      await runOptimistic({
        apply: () => setOptimisticExit(id),
        commit: async () => {
          if (!await execute(() => selectVpsEgress(id))) throw new Error("egress selection failed");
        },
        rollback: () => setOptimisticExit(null)
      });
    } catch {
      // The store retains the error and reloads canonical state.
    } finally { setOptimisticExit(null); }
  };
  const exits = data?.exits ?? [];
  const providers = data?.magpie.providers ?? [];
  const bindings = (id: string) =>
    Math.max(
      data?.magpie.references[id] ?? 0,
      providers.flatMap(p => p.targets).filter(a => a.effective_exit === id).length
    );
  return (
    <section className="surface egress-card" aria-label={t("egress.title")}>
      <div className="egress-heading">
        <div>
          <h2 className="section-title">{t("egress.title")}</h2>
          <p className="network-hint">{t("egress.subtitle")}</p>
        </div>
        <div className="network-actions">
          <button
            className="btn btn-primary"
            disabled={disabled || !data?.management || !data.installed || !!data.error}
            onClick={() => setDialog("create")}
          >
            {t("egress.create")}
          </button>
          <Menu label={t("route.exit_actions")} items={[
            { label: t("egress.refresh"), disabled, onSelect: () => void refresh() },
            { label: t("egress.management"), disabled, onSelect: () => setDialog("management") }
          ]} />
        </div>
      </div>
      <NetworkError error={[error, data?.magpie.error].filter(Boolean).join(" · ")} />
      {!data && !error ? <Skeleton height={64} lines={3} /> : !data?.management ? (
        <div className="egress-empty">
          <p>{t("egress.setup_hint")}</p>
          <button className="btn" disabled={disabled} onClick={() => setDialog("management")}>
            {t("egress.setup")}
          </button>
        </div>
      ) : (
        <>
          <div className="section-block">
            <div className="section-block-head"><h3>{t("egress.pingu_exit")}</h3></div>
            {data.selected !== "direct" && !exits.some(e => e.id === data.selected) && !loading
              && <p className="network-hint" role="status">{t("egress.selected_missing")}</p>}
            <div className="egress-options" role="radiogroup" aria-label={t("egress.pingu_exit")}>
              <div className="row egress-option" data-selected={selectedExit === "direct"}>
                <label className="egress-choice">
                  <input
                    type="radio"
                    name="pingu-exit"
                    checked={selectedExit === "direct"}
                    disabled={disabled}
                    onChange={() => void selectExit("direct")}
                  />
                  <span className="egress-row-info">
                    <strong>{t("egress.direct")}</strong>
                    <span className="egress-address">{data.management.proxy_server}</span>
                    <span className="network-hint">{t("egress.direct_hint")}</span>
                  </span>
                  {selectedExit === "direct" && <span className="pill pill-accent">{t("egress.selected")}</span>}
                </label>
              </div>
              {exits.map(exit => {
                const bindingCount = bindings(exit.id);
                const changing = exit.phase === "creating" || exit.phase === "deleting";
                const deleteReason = bindingCount > 0
                  ? `${t("egress.bound_count")} ${bindingCount}`
                  : data.magpie.error ? t("route.bindings_unavailable") : "";
                return (
                  <div className="row egress-option" key={exit.id} data-selected={selectedExit === exit.id}>
                    <label className="egress-choice">
                      <input
                        type="radio"
                        name="pingu-exit"
                        checked={selectedExit === exit.id}
                        disabled={disabled || changing || !exit.ready || !data.eligible_proxy}
                        onChange={() => void selectExit(exit.id)}
                      />
                      <span className="egress-row-info">
                        <strong>{exit.name}</strong>
                        <span className="egress-address">{exit.ip ?? "—"}<span>{exit.location}</span></span>
                        {exit.checked_at && <span className="egress-checked">
                          {t("egress.checked")} {new Date(exit.checked_at).toLocaleString()}
                        </span>}
                        {exit.error && <span className="egress-row-error" role="status">{exit.error}</span>}
                        {changing && <span
                          className="progress progress-indeterminate"
                          role="progressbar"
                          aria-label={t(`egress.phase_${exit.phase}`)}
                        />}
                      </span>
                    </label>
                    <div className="egress-row-status">
                      <span className="pill" data-state={exit.ready && !changing ? "active" : undefined}>
                        {exit.phase === "ready" && !exit.ready
                          ? t("egress.unavailable") : t(`egress.phase_${exit.phase}`)}
                      </span>
                      {bindingCount > 0 && <span className="pill" title={deleteReason}>
                        {t("route.bindings")} {bindingCount}
                      </span>}
                      <div className="row-actions">
                        <Menu label={`${exit.name} · ${t("route.exit_actions")}`} items={[
                          ...(exit.phase === "creating" ? [{
                            label: t("egress.retry_create"), disabled: disabled || exit.id === "legacy",
                            onSelect: () => void execute(() => createCloudflareEgress(exit.name, exit.id))
                          }] : []),
                          { label: t("egress.rename"), disabled, onSelect: () => setEdit({ kind: "rename", exit }) },
                          {
                            label: `${t("network.delete")}${deleteReason ? ` · ${deleteReason}` : ""}`,
                            tone: "danger", disabled: disabled || !!deleteReason,
                            onSelect: () => setEdit({ kind: "delete", exit })
                          }
                        ]} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {!data.installed && !data.error && <p className="network-hint">{t("egress.install_hint")}</p>}
            {!data.eligible_proxy && <p className="network-hint">{t("egress.select_node_hint")}</p>}
          </div>
          <div className="section-block magpie-egress">
            <div className="section-block-head"><h3>{t("egress.magpie_title")}</h3></div>
            <p className="network-hint">{t("egress.magpie_hint")}</p>
            {!data.magpie.available ? <p className="network-hint">{t("egress.magpie_unavailable")}</p> : (
              <>
                {!providers.length && !data.magpie.error
                  && <p className="network-hint">{t("egress.magpie_empty")}</p>}
                {providers.map(provider => (
                  <section key={provider.id} className="magpie-provider" aria-label={provider.name}>
                    <h4>{provider.name}</h4>
                    {provider.warning && <p className="network-hint">{t("egress.loopback_warning")}</p>}
                    {provider.targets.map(account => (
                      <MagpieBinding
                        key={account.ref}
                        provider={provider}
                        account={account}
                        exits={exits}
                        disabled={disabled || !!data.magpie.error}
                      />
                    ))}
                  </section>
                ))}
                {data.magpie.web_url && <p className="network-hint egress-checked">
                  {t("egress.magpie_manage")} <span className="magpie-admin-address">{data.magpie.web_url}</span>
                </p>}
              </>
            )}
          </div>
          {busy && <p className="network-hint" role="status">
            <span className="route-spinner" aria-hidden="true" /> {t("egress.working")}
          </p>}
        </>
      )}
      {dialog === "management" && <ManagementDialog onClose={() => setDialog(null)} />}
      {dialog === "create" && <CreateDialog onClose={() => setDialog(null)} />}
      {edit?.kind === "rename" && <CreateDialog exit={edit.exit} onClose={() => setEdit(null)} />}
      {edit?.kind === "delete"
        && (
          <Modal
            title={`${t("egress.delete_title")} · ${edit.exit.name}`}
            onClose={() => { if (!busy) setEdit(null); }}
          >
            <p className="network-hint">{t("egress.delete_hint")}</p>
            <NetworkError error={error} />
            <div className="dialog-actions">
              <button className="btn" disabled={busy} onClick={() => setEdit(null)}>
                {t("network.cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() =>
                  void execute(() => deleteCloudflareEgress(edit.exit.id)).then(ok => { if (ok) setEdit(null); })}
              >
                {busy ? t("network.saving") : t("network.delete")}
              </button>
            </div>
          </Modal>
        )}
    </section>
  );
}
