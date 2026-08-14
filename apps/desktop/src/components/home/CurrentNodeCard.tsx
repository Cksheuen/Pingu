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
  const ruleGroup = hasRuleGroup
    ? activeRuleGroupName ?? activeRuleGroupId
    : connected
      ? t("home.no_rule_group")
      : t("home.no_rule_group_disconnected");

  return (
    <section className="surface readout-card">
      <div className="readout-card-head">
        <span className="section-label">{t("home.current_node")}</span>
      </div>
      <div className="readout-primary">
        <p>{activeNode ? activeNode.name : t("home.no_node")}</p>
        {activeNode && (
          <span className="protocol-tag">
            VLESS{activeNode.security ? ` / ${activeNode.security.toUpperCase()}` : ""}
          </span>
        )}
      </div>
      {activeNode && (
        <div className="readout-data">
          <span>{activeNode.address}:{activeNode.port}</span>
          {activeNode.security === "reality" && <Tooltip text={t("tooltip.reality")} />}
        </div>
      )}
      <div className="readout-rule">
        <span>{t("home.current_rule_group")}</span>
        <strong>{ruleGroup}</strong>
      </div>
    </section>
  );
}
