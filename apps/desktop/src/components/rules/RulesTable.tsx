import type { Rule, RuleType } from "../../lib/types";
import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  geosite: "GeoSite",
  geoip: "GeoIP",
  domain_suffix: "Domain Suffix",
  domain: "Domain",
  ip_cidr: "IP CIDR",
  ip_is_private: "IP Private",
};

const OUTBOUND_LABELS = {
  direct: "✓ Direct",
  proxy: "◐ Proxy",
  block: "✕ Block",
} as const;

const TYPE_TOOLTIP_KEYS: Record<RuleType, string> = {
  geosite: "tooltip.geosite",
  geoip: "tooltip.geoip",
  domain_suffix: "tooltip.domain_suffix",
  domain: "tooltip.domain",
  ip_cidr: "tooltip.ip_cidr",
  ip_is_private: "tooltip.ip_is_private",
};

const OUTBOUND_TOOLTIP_KEYS = {
  direct: "tooltip.outbound_direct",
  proxy: "tooltip.outbound_proxy",
  block: "tooltip.outbound_block",
} as const;

interface RulesTableProps {
  rules: Rule[];
  onDeleteRule: (id: string) => Promise<void>;
}

export function RulesTable({ rules, onDeleteRule }: RulesTableProps) {
  return (
    <div className="surface rules-table-shell overflow-hidden flex-1 flex flex-col" style={{ boxShadow: "none" }}>
      <div
        className="rules-table-scroll overflow-x-auto"
      >
      <div
        className="rules-table-header grid font-mono text-text-muted tracking-[2px] uppercase"
        style={{
          gridTemplateColumns: "140px 1fr 120px 40px",
          backgroundColor: "var(--color-inset)",
          padding: "10px 16px",
          fontSize: "10px",
        }}
      >
        <span>{t("rules.type")}</span>
        <span>{t("rules.match")}</span>
        <span>{t("rules.outbound")}</span>
        <span />
      </div>

      <div className="rules-table-body flex-1 overflow-y-auto">
        {rules.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <p className="font-mono text-text-muted" style={{ fontSize: "13px" }}>
              {t("rules.empty")}
            </p>
          </div>
        )}
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="rules-table-row grid items-center"
            style={{
              gridTemplateColumns: "140px 1fr 120px 40px",
              padding: "12px 16px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span className="flex items-center gap-1">
              <span
                className="inline-block font-mono text-accent rounded"
                style={{ backgroundColor: "var(--color-inset)", fontSize: "11px", padding: "2px 8px" }}
              >
                {RULE_TYPE_LABELS[rule.rule_type]}
              </span>
              <Tooltip text={t(TYPE_TOOLTIP_KEYS[rule.rule_type])} />
            </span>

            <span className="font-mono text-text-primary truncate pr-4" style={{ fontSize: "13px" }}>
              {rule.match_value}
            </span>

            <span className="flex items-center gap-1">
              <span
                className="font-mono"
                style={{
                  fontSize: "12px",
                  color: rule.outbound === "proxy" ? "var(--color-accent)" : "var(--color-text-secondary)",
                }}
              >
                {OUTBOUND_LABELS[rule.outbound]}
              </span>
              <Tooltip text={t(OUTBOUND_TOOLTIP_KEYS[rule.outbound])} />
            </span>

            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(t("rules.delete_confirm"))) return;
                  void onDeleteRule(rule.id);
                }}
                aria-label={`Delete rule for ${rule.match_value}`}
                className="table-action-button"
              >
                <XIcon />
              </button>
            </div>
          </div>
          ))}
      </div>
      </div>
    </div>
  );
}
