import { t } from "../../lib/i18n";

interface ConnectionStatusHeaderProps {
  connected: boolean;
}

export function ConnectionStatusHeader({ connected }: ConnectionStatusHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
        {t("home.connection")}
      </span>
      <div className="flex items-center gap-2">
        <span
          className="rounded-full"
          style={{
            width: "8px",
            height: "8px",
            backgroundColor: connected ? "#22D3EE" : "#64748B",
          }}
        />
        <span className="font-mono text-xs" style={{ color: connected ? "#22D3EE" : "#64748B" }}>
          {connected ? t("home.connected") : t("home.disconnected")}
        </span>
      </div>
    </div>
  );
}
