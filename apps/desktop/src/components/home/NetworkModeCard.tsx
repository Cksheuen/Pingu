import { useState } from "react";
import { setNetworkMode } from "../../lib/connection-api";
import { useConnectionStore } from "../../lib/connection-store";
import { useRuntimeOperation } from "../../lib/runtime-operation";
import Tooltip from "../Tooltip";
import { t } from "../../lib/i18n";

export function NetworkModeCard() {
  const status = useConnectionStore(s => s.status);
  const refresh = useConnectionStore(s => s.refreshStatus);
  const operation = useRuntimeOperation(s => s.command);
  const [error, setError] = useState<string | null>(null);
  const mode = status.network_mode;
  const busy = !!operation || !["connected", "disconnected"].includes(status.phase);
  async function change(next: "system" | "tun") {
    setError(null);
    try { await setNetworkMode(next); }
    catch (cause) { setError(typeof cause === "string" ? cause : String(cause)); }
    finally { await refresh().catch(() => undefined); }
  }
  return (
    <div className="network-mode-card">
      <Tooltip text={[
        t(mode === "tun" ? "tun.description" : "tun.system_description"),
        status.connected ? t("tun.disconnect_to_change") : "",
      ].filter(Boolean).join(" ")} />
      <div className="segmented" role="group" aria-label={t("tun.network_mode")}>
        {(["system", "tun"] as const).map(item => (
          <button
            key={item}
            type="button"
            aria-pressed={mode === item}
            data-active={mode === item}
            disabled={status.connected || busy}
            onClick={() => void change(item)}
          >
            {t(item === "tun" ? "tun.label" : "tun.system")}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="network-mode-error">{error}</p>}
    </div>
  );
}
