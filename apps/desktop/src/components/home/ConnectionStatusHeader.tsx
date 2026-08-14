import { t } from "../../lib/i18n";

interface ConnectionStatusHeaderProps {
  connected: boolean;
}

export function ConnectionStatusHeader({ connected }: ConnectionStatusHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <p className="page-kicker">{t("home.workspace_kicker")}</p>
        <h1 className="page-title">{t("home.workspace_title")}</h1>
        <p className="page-description">{t("home.workspace_desc")}</p>
      </div>
      <div className="status-chip" data-state={connected ? "active" : "idle"}>
        <span className="status-dot" />
        <span>
          {connected ? t("home.connected") : t("home.disconnected")}
        </span>
      </div>
    </header>
  );
}
