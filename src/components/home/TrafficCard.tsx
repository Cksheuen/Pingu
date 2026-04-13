import { t } from "../../lib/i18n";

export function TrafficCard() {
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
            --
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-text-secondary text-sm">↓</span>
            <span className="font-mono text-text-secondary" style={{ fontSize: "12px" }}>{t("home.download")}</span>
          </div>
          <span className="font-mono text-text-primary font-semibold" style={{ fontSize: "13px" }}>
            --
          </span>
        </div>
      </div>
    </div>
  );
}
