import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import Chain from "./Chain";
import Strategies from "./Strategies";
import { EgressCard } from "../components/home/EgressCard";
import { publishChainRoute } from "../hooks/useRouteSummary";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { t } from "../lib/i18n";
import Subscriptions from "./Subscriptions";
import Nodes from "./Nodes";
import Rules from "./Rules";
import HostOverrides from "./HostOverrides";
import Connections from "./Connections";
import Logs from "./Logs";

function WorkspacePage({ title, children, className = "" }: {
  title: string; children: ReactNode; className?: string;
}) {
  useI18nRerender();
  return (
    <div className={`page-shell workspace-page ${className}`}>
      <header className="page-header"><h1 className="page-title">{t(title)}</h1></header>
      {children}
    </div>
  );
}

export function Sources() {
  return (
    <WorkspacePage title="workspace.sources">
      <section id="subscriptions"><Subscriptions /></section>
      <section id="manual-nodes"><Nodes /></section>
    </WorkspacePage>
  );
}

export function Routing() {
  return (
    <WorkspacePage title="workspace.routing">
      <Rules />
      <section id="host-overrides"><HostOverrides /></section>
    </WorkspacePage>
  );
}

export function Activity() {
  return (
    <WorkspacePage title="workspace.activity">
      <Connections /><section id="logs"><Logs /></section>
    </WorkspacePage>
  );
}

const routeSections = [
  { id: "chain", label: "nav.chain" },
  { id: "egress", label: "route.exits" },
  { id: "strategies", label: "nav.strategies" },
];

export function Route() {
  useI18nRerender();
  const { hash } = useLocation();
  const [active, setActive] = useState(hash.slice(1) || "chain");
  const sections = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (routeSections.some(section => `#${section.id}` === hash)) setActive(hash.slice(1));
  }, [hash]);
  useEffect(() => {
    const root = document.querySelector(".app-main");
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      }
      const first = [...visible.entries()].sort((left, right) => left[1] - right[1])[0];
      if (first) setActive(first[0]);
    }, { root, rootMargin: "-56px 0px -25% 0px", threshold: [0, 0.1, 0.5, 1] });
    sections.current?.querySelectorAll(":scope > section").forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, []);
  return <WorkspacePage title="workspace.route" className="route-page">
    <nav className="segmented route-subnav" aria-label={t("workspace.route")}>
      {routeSections.map(section => <Link
        key={section.id}
        to={`/route#${section.id}`}
        data-active={active === section.id}
        aria-current={active === section.id ? "location" : undefined}
      >{t(section.label)}</Link>)}
    </nav>
    <div className="route-sections" ref={sections}>
      <section id="chain"><Chain onRouteChange={publishChainRoute} /></section>
      <section id="egress"><EgressCard /></section>
      <section id="strategies"><Strategies /></section>
    </div>
  </WorkspacePage>;
}
