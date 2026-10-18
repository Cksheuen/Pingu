import { useState } from "react";
import { setNetworkMode } from "../../lib/connection-api";
import { useConnectionStore } from "../../lib/connection-store";
import { useRuntimeOperation } from "../../lib/runtime-operation";
import { t } from "../../lib/i18n";

export function NetworkModeCard() {
  const status = useConnectionStore(s => s.status);
  const refresh = useConnectionStore(s => s.refreshStatus);
  const operation = useRuntimeOperation(s => s.command);
  const [error, setError] = useState<string | null>(null);
  const mode = status.network_mode ?? "system";
  const busy = !!operation || !!status.phase && !["connected", "disconnected"].includes(status.phase);
  async function change(next: "system" | "tun") {
    setError(null);
    try { await setNetworkMode(next); }
    catch (cause) { setError(typeof cause === "string" ? cause : String(cause)); }
    finally { await refresh().catch(() => undefined); }
  }
  return <section className="surface network-mode-card" aria-label={t("tun.network_mode")}>
    <div className="network-mode-copy"><strong>{t("tun.network_mode")}</strong>
      <p>{t(mode === "tun" ? "tun.description" : "tun.system_description")}</p>
      {status.connected && <span className="network-hint">{t("tun.disconnect_to_change")}</span>}
    </div>
    <div className="network-mode-options" role="group" aria-label={t("tun.network_mode")}>
      {(["system", "tun"] as const).map(item => <button key={item} type="button" aria-pressed={mode === item}
        className={mode === item ? "action-primary" : "action-secondary"} disabled={status.connected || busy}
        onClick={() => void change(item)}>{t(item === "tun" ? "tun.label" : "tun.system")}</button>)}
    </div>
    {error && <p role="alert" className="network-mode-error">{error}</p>}
  </section>;
}
