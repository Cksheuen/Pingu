import { Link } from "react-router-dom";
import { t } from "../../lib/i18n";

export function NetworkError({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="network-error" role="alert"><span>{error}</span>{onRetry && <button className="action-secondary" onClick={onRetry}>{t("network.retry")}</button>}</div>;
}

export function RuntimeOffline() {
  return <div className="surface empty-state"><span className="network-empty-mark" aria-hidden="true">○</span><h2>{t("network.offline")}</h2><p>{t("network.offline_desc")}</p><Link to="/" className="action-primary">{t("network.go_home")}</Link></div>;
}

export function NetworkLoading() {
  return <div className="empty-state" role="status"><span className="network-spinner" aria-hidden="true" /><p>{t("network.loading")}</p></div>;
}
