import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

interface RuleStrategyCardProps {
  strategy: "direct" | "proxy";
  onChangeStrategy: (strategy: "direct" | "proxy") => Promise<void>;
}

export function RuleStrategyCard({ strategy, onChangeStrategy }: RuleStrategyCardProps) {
  return (
    <div className="surface rule-strategy-card flex items-center justify-between" style={{ padding: "16px", boxShadow: "none" }}>
      <div>
        <span className="flex items-center mb-1">
          <p className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "10px" }}>
            {t("rules.default_strategy")}
          </p>
          <Tooltip text={t("tooltip.default_strategy")} />
        </span>
        <p className="font-sans text-text-secondary" style={{ fontSize: "13px" }}>
          {strategy === "proxy" ? t("rules.default_desc_proxy") : t("rules.default_desc_direct")}
        </p>
      </div>
      <div className="strategy-selector">
        {(["direct", "proxy"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => void onChangeStrategy(option)}
            aria-pressed={strategy === option}
            data-active={strategy === option}
          >
            {option === "direct" ? t("rules.direct") : t("rules.proxy")}
          </button>
        ))}
      </div>
    </div>
  );
}
