import { Link } from "react-router-dom";
import type { Node } from "../../lib/types";
import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

interface CurrentNodeCardProps {
  activeNode: Node | null;
  subscriptionMode?: boolean;
  chainMode?: boolean;
  connected: boolean;
  activeRuleGroupId: string | null;
  activeRuleGroupName: string | null;
  hasRuleGroup: boolean;
}

export function CurrentNodeCard({
  activeNode,
  subscriptionMode = false,
  chainMode = false,
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
        <p>{chainMode ? t("nav.chain") : subscriptionMode ? t("home.subscription_route") : activeNode ? activeNode.name : t("home.no_node")}</p>
        {activeNode && !chainMode && (
          <span className="protocol-tag">
            VLESS{activeNode.security ? ` / ${activeNode.security.toUpperCase()}` : ""}
          </span>
        )}
      </div>
      {chainMode && <Link className="network-text-link" to="/chain">{t("home.manage_routes")} →</Link>}
      {subscriptionMode && !chainMode && <Link className="network-text-link" to="/strategies">{t("home.manage_routes")} →</Link>}
      {activeNode && !subscriptionMode && !chainMode && (
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
