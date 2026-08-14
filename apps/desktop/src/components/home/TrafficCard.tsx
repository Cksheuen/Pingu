import { useEffect, useRef, useState } from "react";
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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!connected) {
      setTraffic(null);
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    const poll = () => getTraffic().then(setTraffic).catch(() => undefined);
    poll();
    intervalRef.current = setInterval(poll, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
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
