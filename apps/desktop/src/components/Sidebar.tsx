import { NavLink } from "react-router-dom";
import { t } from "../lib/i18n";
import { useConnectionStore } from "../lib/connection-store";
import LangSwitch from "./LangSwitch";
import { useI18nRerender } from "../hooks/useI18nRerender";

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function NetworkIcon({ kind }: { kind: "subscriptions" | "strategies" | "connections" }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "subscriptions" ? <><rect x="4" y="3" width="16" height="5" rx="1" /><rect x="4" y="10" width="16" height="5" rx="1" /><path d="M4 19h16M8 5.5h.01M8 12.5h.01" /></> : kind === "strategies" ? <><path d="M4 6h16M4 18h16M8 6v12M16 6v12" /><circle cx="8" cy="10" r="2" /><circle cx="16" cy="14" r="2" /></> : <><path d="M3 8h17l-4-4M21 16H4l4 4" /><circle cx="3" cy="8" r="1" /><circle cx="21" cy="16" r="1" /></>}
  </svg>;
}

function NodesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="3" />
      <circle cx="5" cy="19" r="3" />
      <circle cx="19" cy="19" r="3" />
      <line x1="12" y1="8" x2="5.5" y2="16.5" />
      <line x1="12" y1="8" x2="18.5" y2="16.5" />
    </svg>
  );
}

function RulesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function HostOverridesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4Z" />
      <path d="M9.5 12l1.5 1.5 3.5-3.5" />
    </svg>
  );
}

export default function Sidebar() {
  useI18nRerender();

  const connected = useConnectionStore((s) => s.status.connected);
  const activeNodeId = useConnectionStore((s) => s.status.active_node_id);
  const nodes = useConnectionStore((s) => s.nodes);
  const activeNodeName =
    nodes.find((node) => node.id === activeNodeId)?.name ??
    (activeNodeId === "__subscriptions__" ? t("home.subscription_route") : null);
  // The rail hides the status text at narrow widths, so the link's name must
  // carry the real state instead of the generic section label alone.
  const statusLabel = `${t("sidebar.relay_status")}: ${connected ? t("home.connected") : t("home.disconnected")} · ${activeNodeName ?? t("home.no_node")}`;

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `sidebar-link ${isActive ? "sidebar-link-active" : ""}`;

  return (
    <aside className="sidebar">
      <div>
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">P</span>
          <div>
            <span className="sidebar-wordmark">Pingu</span>
            <span className="sidebar-edition">private relay</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/" end className={navClass} aria-label={t("nav.home")} title={t("nav.home")}>
            <HomeIcon />
            <span className="sidebar-link-label">{t("nav.home")}</span>
          </NavLink>
          {(["subscriptions", "strategies", "connections"] as const).map((page) => <NavLink key={page} to={`/${page}`} className={navClass} aria-label={t(`nav.${page}`)} title={t(`nav.${page}`)}><NetworkIcon kind={page} /><span className="sidebar-link-label">{t(`nav.${page}`)}</span></NavLink>)}
          <NavLink to="/nodes" className={navClass} aria-label={t("nav.nodes")} title={t("nav.nodes")}>
            <NodesIcon />
            <span className="sidebar-link-label">{t("nav.nodes")}</span>
          </NavLink>
          <NavLink to="/rules" className={navClass} aria-label={t("nav.rules")} title={t("nav.rules")}>
            <RulesIcon />
            <span className="sidebar-link-label">{t("nav.rules")}</span>
          </NavLink>
          <NavLink to="/host-overrides" className={navClass} aria-label={t("nav.host_overrides")} title={t("nav.host_overrides")}>
            <HostOverridesIcon />
            <span className="sidebar-link-label">{t("nav.host_overrides")}</span>
          </NavLink>
          <NavLink to="/logs" className={navClass} aria-label={t("nav.logs")} title={t("nav.logs")}>
            <LogsIcon />
            <span className="sidebar-link-label">{t("nav.logs")}</span>
          </NavLink>
          <NavLink to="/settings" className={navClass} aria-label={t("nav.settings")} title={t("nav.settings")}>
            <SettingsIcon />
            <span className="sidebar-link-label">{t("nav.settings")}</span>
          </NavLink>
        </nav>
      </div>
      <div className="sidebar-footer">
        <NavLink
          to="/"
          className="sidebar-status"
          data-state={connected ? "active" : "idle"}
          aria-label={statusLabel}
          title={statusLabel}
        >
          <span className="sidebar-status-dot" />
          <span className="sidebar-status-text">
            <span className="sidebar-status-label">
              {connected ? t("home.connected") : t("home.disconnected")}
            </span>
            <span className="sidebar-status-detail">
              {activeNodeName ?? t("home.no_node")}
            </span>
          </span>
        </NavLink>
        <LangSwitch />
      </div>
    </aside>
  );
}
