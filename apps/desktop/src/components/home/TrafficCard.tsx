import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { getTraffic } from "../../lib/traffic-api";
import { useConnectionStore } from "../../lib/connection-store";
import type { TrafficSnapshot } from "../../lib/types";

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function TrafficCard() {
  const connected = useConnectionStore((state) => state.status.connected);
  const [traffic, setTraffic] = useState<TrafficSnapshot | null>(null);

  useEffect(() => {
    if (!connected) {
      setTraffic(null);
      return;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!stopped && document.visibilityState === "visible") {
        timer = setTimeout(poll, 2_000);
      }
    };

    const poll = async () => {
      try {
        const snapshot = await getTraffic();
        if (!stopped) setTraffic(snapshot);
      } catch {
        // Traffic is auxiliary; keep the connection UI responsive on a failed probe.
      }
      schedule();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer) clearTimeout(timer);
      void poll();
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [connected]);

  const upSpeed = connected && traffic ? formatSpeed(traffic.upload_speed) : "—";
  const downSpeed = connected && traffic ? formatSpeed(traffic.download_speed) : "—";

  return (
    <section className="surface readout-card traffic-readout">
      <div className="readout-card-head">
        <span className="section-label">{t("home.traffic")}</span>
      </div>
      <div className="traffic-grid">
        <div>
          <span>↑ {t("home.upload")}</span>
          <strong>{upSpeed}</strong>
        </div>
        <div>
          <span>↓ {t("home.download")}</span>
          <strong>{downSpeed}</strong>
        </div>
      </div>
    </section>
  );
}
