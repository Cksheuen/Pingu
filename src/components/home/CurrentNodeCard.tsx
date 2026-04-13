import type { Node } from "../../lib/types";
import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

interface CurrentNodeCardProps {
  activeNode: Node | null;
  connected: boolean;
  activeRuleGroupId: string | null;
  activeRuleGroupName: string | null;
  hasRuleGroup: boolean;
}

export function CurrentNodeCard({
  activeNode,
  connected,
  activeRuleGroupId,
  activeRuleGroupName,
  hasRuleGroup,
}: CurrentNodeCardProps) {
  return (
    <div className="bg-card rounded-xl" style={{ padding: "16px" }}>
      <p className="font-mono text-text-muted tracking-[2px] uppercase mb-3" style={{ fontSize: "10px" }}>
        {t("home.current_node")}
      </p>
      <p className="font-sans font-semibold text-text-primary mb-2" style={{ fontSize: "15px" }}>
        {activeNode ? activeNode.name : t("home.no_node")}
      </p>
      {activeNode && (
        <>
          <span className="inline-flex items-center">
            <span
              className="inline-block font-mono text-accent rounded-full mb-2"
              style={{ backgroundColor: "#0F172A", fontSize: "10px", padding: "2px 8px" }}
            >
              VLESS{activeNode.security ? ` + ${activeNode.security.toUpperCase()}` : ""}
            </span>
            {activeNode.security === "reality" && <Tooltip text={t("tooltip.reality")} />}
          </span>
          <p className="font-mono text-text-secondary" style={{ fontSize: "12px" }}>
            {activeNode.address}:{activeNode.port}
          </p>
        </>
      )}
      <div style={{ marginTop: "14px" }}>
        <p className="font-mono text-text-muted tracking-[2px] uppercase mb-2" style={{ fontSize: "10px" }}>
          {t("home.current_rule_group")}
        </p>
        <p className="font-sans font-semibold text-text-primary" style={{ fontSize: "14px" }}>
          {hasRuleGroup
            ? activeRuleGroupName ?? activeRuleGroupId
            : connected
              ? t("home.no_rule_group")
              : t("home.no_rule_group_disconnected")}
        </p>
        {hasRuleGroup && activeRuleGroupName && activeRuleGroupId && (
          <p className="font-mono text-text-secondary mt-1" style={{ fontSize: "12px" }}>
            {activeRuleGroupId}
          </p>
        )}
      </div>
    </div>
  );
}
