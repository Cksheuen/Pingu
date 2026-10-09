import type { ReactNode } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { t } from "../lib/i18n";
import Subscriptions from "./Subscriptions";
import Nodes from "./Nodes";
import Rules from "./Rules";
import HostOverrides from "./HostOverrides";
import Connections from "./Connections";
import Logs from "./Logs";

function WorkspacePage({ title, children }: { title: string; children: ReactNode }) {
  useI18nRerender();
  return <div className="page-shell workspace-page"><SectionHeader title={t(title)} />{children}</div>;
}

export function Sources() {
  return <WorkspacePage title="workspace.sources"><section id="subscriptions"><Subscriptions embedded /></section><section id="manual-nodes"><Nodes embedded /></section></WorkspacePage>;
}

export function Routing() {
  return <WorkspacePage title="workspace.routing"><Rules embedded /><section id="host-overrides"><HostOverrides embedded /></section></WorkspacePage>;
}

export function Activity() {
  return <WorkspacePage title="workspace.activity"><Connections embedded /><section id="logs"><Logs embedded /></section></WorkspacePage>;
}
