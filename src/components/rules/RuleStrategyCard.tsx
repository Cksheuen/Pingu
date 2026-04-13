import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

interface RuleStrategyCardProps {
  strategy: "direct" | "proxy";
  onChangeStrategy: (strategy: "direct" | "proxy") => Promise<void>;
}

export function RuleStrategyCard({ strategy, onChangeStrategy }: RuleStrategyCardProps) {
  return (
    <div className="bg-card rounded-xl flex items-center justify-between" style={{ padding: "16px" }}>
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
      <div className="flex rounded-md overflow-hidden" style={{ gap: "2px", backgroundColor: "#0F172A", padding: "4px" }}>
        {(["direct", "proxy"] as const).map((option) => (
          <button
            key={option}
            onClick={() => void onChangeStrategy(option)}
            aria-pressed={strategy === option}
            className="font-mono transition-colors rounded-md"
            style={{
              fontSize: "12px",
              padding: "6px 14px",
              backgroundColor: strategy === option ? "#22D3EE" : "transparent",
              color: strategy === option ? "#0A0F1C" : "#64748B",
            }}
          >
            {option === "direct" ? t("rules.direct") : t("rules.proxy")}
          </button>
        ))}
      </div>
    </div>
  );
}
