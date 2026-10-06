import { NavLink } from "react-router-dom";
import { t } from "../lib/i18n";
import { useConnectionStore } from "../lib/connection-store";
import { useI18nRerender } from "../hooks/useI18nRerender";

const sections = [
  { path: "/", label: "workspace.connection", icon: "M12 3v8M6.3 5.7a8 8 0 1 0 11.4 0" },
  { path: "/sources", label: "workspace.sources", icon: "M4 3h16v7H4zM4 14h16v7H4zM8 6h.01M8 17h.01" },
  { path: "/routing", label: "workspace.routing", icon: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6" },
  { path: "/activity", label: "workspace.activity", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { path: "/mesh", label: "workspace.mesh", icon: "M6 6h4v4H6zM16 6h4v4h-4zM11 17h4v4h-4zM8 10v3h10v-3M13 13v4" },
  { path: "/settings", label: "nav.settings", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M5.6 18.4l1.5-1.5M16.9 7.1l1.5-1.5" },
];

export default function Sidebar() {
  useI18nRerender();
  const connected = useConnectionStore((state) => state.status.connected);
  return <aside className="sidebar">
    <div>
      <div className="sidebar-brand"><span className="sidebar-mark" aria-hidden="true">P</span><span className="sidebar-wordmark">Pingu</span></div>
      <nav className="sidebar-nav" aria-label={t("workspace.navigation")}>
        {sections.map(({ path, label, icon }) => <NavLink key={path} to={path} end={path === "/"}
          className={({ isActive }) => `sidebar-link ${isActive ? "sidebar-link-active" : ""}`}
          aria-label={t(label)} title={t(label)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
          <span className="sidebar-link-label">{t(label)}</span>
        </NavLink>)}
      </nav>
    </div>
    <div className="sidebar-footer"><NavLink to="/" className="sidebar-status" data-state={connected ? "active" : "idle"}
      aria-label={connected ? t("home.connected") : t("home.disconnected")} title={connected ? t("home.connected") : t("home.disconnected")}>
      <span className="sidebar-status-dot" /><span className="sidebar-status-text">{connected ? t("home.connected") : t("home.disconnected")}</span>
    </NavLink></div>
  </aside>;
}
