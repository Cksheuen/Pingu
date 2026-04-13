import { NavLink } from "react-router-dom";
import { t } from "../lib/i18n";
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

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-[10px] px-3 py-[10px] rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? "bg-card text-accent"
        : "text-text-muted hover:text-text-secondary"
    }`;

  return (
    <div className="w-[200px] h-full bg-sidebar flex flex-col shrink-0 justify-between" style={{ padding: "24px 16px" }}>
      <div>
        <div className="flex items-center gap-2.5 mb-8">
          <span className="text-accent text-xl">&#x2B21;</span>
          <span className="font-mono font-bold text-base text-text-primary">Pingu</span>
        </div>
        <nav className="flex flex-col gap-1">
          <NavLink to="/" end className={navClass}>
            <HomeIcon />
            {t("nav.home")}
          </NavLink>
          <NavLink to="/nodes" className={navClass}>
            <NodesIcon />
            {t("nav.nodes")}
          </NavLink>
          <NavLink to="/rules" className={navClass}>
            <RulesIcon />
            {t("nav.rules")}
          </NavLink>
          <NavLink to="/host-overrides" className={navClass}>
            <HostOverridesIcon />
            {t("nav.host_overrides")}
          </NavLink>
          <NavLink to="/logs" className={navClass}>
            <LogsIcon />
            {t("nav.logs")}
          </NavLink>
        </nav>
      </div>
      <div>
        <LangSwitch />
      </div>
    </div>
  );
}
