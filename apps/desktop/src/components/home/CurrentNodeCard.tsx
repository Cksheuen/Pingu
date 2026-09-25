import { Link } from "react-router-dom";
import type { Node } from "../../lib/types";
import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

interface CurrentNodeCardProps {
  activeNode: Node | null;
  subscriptionMode?: boolean;
  connected: boolean;
  activeRuleGroupId: string | null;
  activeRuleGroupName: string | null;
  hasRuleGroup: boolean;
}

export function CurrentNodeCard({
  activeNode,
  subscriptionMode = false,
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
        <p>{subscriptionMode ? t("home.subscription_route") : activeNode ? activeNode.name : t("home.no_node")}</p>
        {activeNode && (
          <span className="protocol-tag">
            VLESS{activeNode.security ? ` / ${activeNode.security.toUpperCase()}` : ""}
          </span>
        )}
      </div>
      {subscriptionMode && <Link className="network-text-link" to="/strategies">{t("home.manage_routes")} →</Link>}
      {activeNode && !subscriptionMode && (
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
