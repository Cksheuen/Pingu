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
  const connected = useConnectionStore((s) => s.status.connected);
  const [traffic, setTraffic] = useState<TrafficSnapshot | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!connected) {
      setTraffic(null);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const poll = () => {
      getTraffic().then(setTraffic).catch(() => undefined);
    };

    poll();
    intervalRef.current = setInterval(poll, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [connected]);

  const upSpeed = connected && traffic ? formatSpeed(traffic.upload_speed) : "--";
  const downSpeed = connected && traffic ? formatSpeed(traffic.download_speed) : "--";

  return (
    <div className="bg-card rounded-xl" style={{ padding: "16px" }}>
      <p className="font-mono text-text-muted tracking-[2px] uppercase mb-3" style={{ fontSize: "10px" }}>
        {t("home.traffic")}
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-text-secondary text-sm">↑</span>
            <span className="font-mono text-text-secondary" style={{ fontSize: "12px" }}>{t("home.upload")}</span>
          </div>
          <span className="font-mono text-text-primary font-semibold" style={{ fontSize: "13px" }}>
            {upSpeed}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-text-secondary text-sm">↓</span>
            <span className="font-mono text-text-secondary" style={{ fontSize: "12px" }}>{t("home.download")}</span>
          </div>
          <span className="font-mono text-text-primary font-semibold" style={{ fontSize: "13px" }}>
            {downSpeed}
          </span>
        </div>
      </div>
    </div>
  );
}
