import { useEffect, useState } from "react";
import type { Outbound, Rule, RuleType } from "../../lib/types";
import { t } from "../../lib/i18n";

interface AddRuleDialogProps {
  onClose: () => void;
  onAdd: (rule: Omit<Rule, "id">) => Promise<void>;
}

export function AddRuleDialog({ onClose, onAdd }: AddRuleDialogProps) {
  const [ruleType, setRuleType] = useState<RuleType>("geosite");
  const [matchValue, setMatchValue] = useState("");
  const [outbound, setOutbound] = useState<Outbound>("direct");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const isPrivateType = ruleType === "ip_is_private";

  const handleAdd = async () => {
    if (!isPrivateType && !matchValue.trim()) return;

    setLoading(true);
    setError("");
    try {
      await onAdd({
        rule_type: ruleType,
        match_value: isPrivateType ? "true" : matchValue.trim(),
        outbound,
      });
      onClose();
    } catch {
      setError(t("rules.add_error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      role="dialog"
      aria-modal="true"
      aria-label={t("rules.add_title")}
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl w-full"
        style={{ maxWidth: "500px", padding: "24px", margin: "0 16px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-sans font-semibold text-text-primary mb-4" style={{ fontSize: "18px" }}>
          {t("rules.add_title")}
        </h2>

        <div className="mb-4">
          <label className="block font-mono text-text-muted tracking-[2px] uppercase mb-2" style={{ fontSize: "10px" }}>
            {t("rules.type_label")}
          </label>
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as RuleType)}
            aria-label={t("rules.type_label")}
            className="w-full rounded-lg text-text-primary font-mono outline-none"
            style={{
              backgroundColor: "#0F172A",
              border: "none",
              padding: "10px 12px",
              fontSize: "13px",
            }}
          >
            <option value="geosite">GeoSite</option>
            <option value="geoip">GeoIP</option>
            <option value="domain_suffix">Domain Suffix</option>
            <option value="domain">Domain</option>
            <option value="ip_cidr">IP CIDR</option>
            <option value="ip_is_private">IP Private</option>
          </select>
        </div>

        {!isPrivateType && (
          <div className="mb-4">
            <label className="block font-mono text-text-muted tracking-[2px] uppercase mb-2" style={{ fontSize: "10px" }}>
              {t("rules.match_label")}
            </label>
            <input
              type="text"
              value={matchValue}
              onChange={(e) => setMatchValue(e.target.value)}
              placeholder="e.g. cn, 192.168.0.0/16, example.com"
              aria-label={t("rules.match_label")}
              className="w-full rounded-lg text-text-secondary font-mono outline-none placeholder:text-text-muted"
              style={{
                backgroundColor: "#0F172A",
                border: "none",
                padding: "10px 12px",
                fontSize: "13px",
              }}
            />
          </div>
        )}

        <div className="mb-5">
          <p className="font-mono text-text-muted tracking-[2px] uppercase mb-2" style={{ fontSize: "10px" }}>
            {t("rules.outbound_label")}
          </p>
          <div className="flex gap-3">
            {(["direct", "proxy", "block"] as const).map((opt) => (
              <label key={opt} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="outbound"
                  value={opt}
                  checked={outbound === opt}
                  onChange={() => setOutbound(opt)}
                  className="accent-accent"
                />
                <span className="font-mono text-text-secondary capitalize" style={{ fontSize: "13px" }}>
                  {opt}
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-red-400 font-mono mb-3" style={{ fontSize: "12px" }}>
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="font-mono text-text-muted hover:text-text-secondary transition-colors"
            style={{ fontSize: "13px", padding: "8px 14px" }}
          >
            {t("nodes.cancel")}
          </button>
          <button
            onClick={handleAdd}
            disabled={loading || (!isPrivateType && !matchValue.trim())}
            className="font-mono rounded-md transition-colors disabled:opacity-50"
            style={{
              backgroundColor: "#22D3EE",
              color: "#0A0F1C",
              fontSize: "13px",
              padding: "8px 14px",
            }}
          >
            {loading ? t("rules.adding") : t("rules.add")}
          </button>
        </div>
      </div>
    </div>
  );
}
