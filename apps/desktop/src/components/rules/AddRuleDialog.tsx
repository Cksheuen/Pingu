import { useState } from "react";
import type { Outbound, Rule, RuleType } from "../../lib/types";
import { t } from "../../lib/i18n";
import { Modal } from "../Modal";

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
    <Modal title={t("rules.add_title")} onClose={onClose}>
        <div className="dialog-field-group">
          <label className="dialog-field-label">
            {t("rules.type_label")}
          </label>
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as RuleType)}
            aria-label={t("rules.type_label")}
            className="dialog-field"
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
          <div className="dialog-field-group">
            <label className="dialog-field-label">
              {t("rules.match_label")}
            </label>
            <input
              type="text"
              value={matchValue}
              onChange={(e) => setMatchValue(e.target.value)}
              placeholder="e.g. cn, 192.168.0.0/16, example.com"
              aria-label={t("rules.match_label")}
              className="dialog-field"
            />
          </div>
        )}

        <div className="dialog-field-group">
          <p className="dialog-field-label">
            {t("rules.outbound_label")}
          </p>
          <div className="dialog-radio-group">
            {(["direct", "proxy", "block"] as const).map((opt) => (
              <label key={opt} className="dialog-radio-option">
                <input
                  type="radio"
                  name="outbound"
                  value={opt}
                  checked={outbound === opt}
                  onChange={() => setOutbound(opt)}
                  className="accent-accent"
                />
                <span className="dialog-radio-label">
                  {opt}
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <p className="dialog-error">{error}</p>
        )}

        <div className="dialog-actions">
          <button
            onClick={onClose}
            className="action-secondary"
          >
            {t("nodes.cancel")}
          </button>
          <button
            onClick={handleAdd}
            disabled={loading || (!isPrivateType && !matchValue.trim())}
            className="action-primary"
          >
            {loading ? t("rules.adding") : t("rules.add")}
          </button>
        </div>
    </Modal>
  );
}
