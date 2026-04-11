import { useState, useEffect, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { listRules, addRule, deleteRule, setDefaultStrategy, listRuleGroups, getActiveGroupId, setActiveGroup, createRuleGroup, deleteRuleGroup, renameRuleGroup } from "../lib/api";
import type { Rule, RuleGroup, RuleType, Outbound, Strategy } from "../lib/types";
import { t, onLangChange } from "../lib/i18n";
import Tooltip from "../components/Tooltip";

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

const RULE_TYPE_LABELS: Record<string, string> = {
  geosite: "GeoSite",
  geoip: "GeoIP",
  domain_suffix: "Domain Suffix",
  domain: "Domain",
  ip_cidr: "IP CIDR",
  ip_is_private: "IP Private",
};

const OUTBOUND_LABELS: Record<string, string> = {
  direct: "✓ Direct",
  proxy: "◐ Proxy",
  block: "✕ Block",
};

const typeTooltipKey: Record<string, string> = {
  geosite: "tooltip.geosite",
  geoip: "tooltip.geoip",
  domain_suffix: "tooltip.domain_suffix",
  domain: "tooltip.domain",
  ip_cidr: "tooltip.ip_cidr",
  ip_is_private: "tooltip.ip_is_private",
};

const outboundTooltipKey: Record<string, string> = {
  direct: "tooltip.outbound_direct",
  proxy: "tooltip.outbound_proxy",
  block: "tooltip.outbound_block",
};

interface AddRuleDialogProps {
  onClose: () => void;
  onAdd: (rule: Omit<Rule, "id">) => Promise<void>;
}

function AddRuleDialog({ onClose, onAdd }: AddRuleDialogProps) {
  const [ruleType, setRuleType] = useState<RuleType>("geosite");
  const [matchValue, setMatchValue] = useState("");
  const [outbound, setOutbound] = useState<Outbound>("direct");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const isPrivateType = ruleType === "ip_is_private";

  const handleAdd = async () => {
    if (!isPrivateType && !matchValue.trim()) return;
    setLoading(true);
    setError("");
    try {
      await onAdd({ rule_type: ruleType, match_value: isPrivateType ? "true" : matchValue.trim(), outbound });
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
      <div className="bg-card rounded-xl w-full" style={{ maxWidth: "500px", padding: "24px", margin: "0 16px" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="font-sans font-semibold text-text-primary mb-4" style={{ fontSize: "18px" }}>
          {t("rules.add_title")}
        </h2>

        {/* Type select */}
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

        {/* Match input (hidden for ip_is_private) */}
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

        {/* Outbound radio */}
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

export default function Rules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [strategy, setStrategy] = useState<"direct" | "proxy">("proxy");
  const [showAdd, setShowAdd] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [, rerender] = useState(0);

  // Rule Groups state
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [activeGroupId, setActiveGroupIdState] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  useEffect(() => onLangChange(() => rerender((n) => n + 1)), []);

  const loadGroups = useCallback(async () => {
    const [gs, activeId] = await Promise.all([listRuleGroups(), getActiveGroupId()]);
    setGroups(gs);
    setActiveGroupIdState(activeId);
    const r = await listRules();
    setRules(r);
    const activeGroup = gs.find((g) => g.id === activeId);
    if (activeGroup) setStrategy(activeGroup.default_strategy as Strategy);
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  async function handleSwitchGroup(id: string) {
    await setActiveGroup(id);
    setActiveGroupIdState(id);
    const r = await listRules();
    setRules(r);
    const gs = await listRuleGroups();
    setGroups(gs);
    const g = gs.find((g) => g.id === id);
    if (g) setStrategy(g.default_strategy as Strategy);
  }

  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const newGroup = await createRuleGroup(name);
    setNewGroupName("");
    setShowNewGroup(false);
    await handleSwitchGroup(newGroup.id);
  }

  async function handleRenameGroup(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) { setEditingGroupId(null); return; }
    await renameRuleGroup(id, trimmed);
    setEditingGroupId(null);
    setEditingName("");
    const gs = await listRuleGroups();
    setGroups(gs);
  }

  async function handleDeleteGroup(id: string) {
    if (!confirm(t("rules.delete_group_confirm"))) return;
    await deleteRuleGroup(id);
    await loadGroups();
  }

  const handleStrategyChange = async (s: "direct" | "proxy") => {
    setStrategy(s);
    try {
      await setDefaultStrategy(s);
      const gs = await listRuleGroups();
      setGroups(gs);
    } catch {
      // ignore
    }
  };

  const handleAddRule = async (rule: Omit<Rule, "id">) => {
    await addRule(rule);
    const r = await listRules();
    setRules(r);
    const gs = await listRuleGroups();
    setGroups(gs);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ padding: "32px 40px", gap: "24px" }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
          {t("rules.title")}
        </span>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-md font-mono font-medium transition-colors hover:opacity-90"
          style={{
            backgroundColor: "#22D3EE",
            color: "#0A0F1C",
            fontSize: "13px",
            padding: "8px 14px",
          }}
        >
          <PlusIcon />
          {t("rules.add")}
        </button>
      </div>

      {/* Group tab bar */}
      {groups.length > 0 && (
        <div className="flex items-center gap-2">
          <Tooltip text={t("tooltip.rule_groups")} />
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {groups.map((group) => {
              const isActive = group.id === activeGroupId;
              const isEditing = editingGroupId === group.id;

              return (
                <button
                  key={group.id}
                  onClick={() => { if (!isEditing) handleSwitchGroup(group.id); }}
                  className="flex items-center rounded-lg font-mono text-sm transition-colors shrink-0"
                  style={{
                    backgroundColor: isActive ? "#22D3EE" : "#0F172A",
                    color: isActive ? "#0A0F1C" : "#64748B",
                    padding: "8px 16px",
                    fontWeight: isActive ? 600 : 500,
                  }}
                  onMouseEnter={(e) => { if (!isActive) (e.currentTarget.style.color = "#CBD5E1"); }}
                  onMouseLeave={(e) => { if (!isActive) (e.currentTarget.style.color = "#64748B"); }}
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameGroup(group.id, editingName);
                        if (e.key === "Escape") { setEditingGroupId(null); setEditingName(""); }
                      }}
                      onBlur={() => handleRenameGroup(group.id, editingName)}
                      onClick={(e) => e.stopPropagation()}
                      className="bg-transparent font-mono text-sm outline-none"
                      style={{
                        color: "#0A0F1C",
                        borderBottom: "1px solid rgba(10,15,28,0.4)",
                        width: "96px",
                      }}
                    />
                  ) : (
                    <>
                      <span>{group.name}</span>
                      {isActive && (
                        <>
                          <span
                            className="ml-2 hover:opacity-100 transition-opacity cursor-pointer"
                            style={{ opacity: 0.6 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingGroupId(group.id);
                              setEditingName(group.name);
                            }}
                            title={t("rules.rename")}
                          >
                            <PencilIcon />
                          </span>
                          {groups.length > 1 && (
                            <span
                              className="ml-1 hover:opacity-100 transition-opacity cursor-pointer"
                              style={{ opacity: 0.6 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteGroup(group.id);
                              }}
                              title={t("rules.delete_group")}
                            >
                              <TrashIcon />
                            </span>
                          )}
                        </>
                      )}
                    </>
                  )}
                </button>
              );
            })}

            {/* New group button / inline form */}
            {showNewGroup ? (
              <div className="flex items-center gap-2 shrink-0">
                <input
                  autoFocus
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateGroup();
                    if (e.key === "Escape") { setShowNewGroup(false); setNewGroupName(""); }
                  }}
                  placeholder={t("rules.group_name_placeholder")}
                  className="font-mono text-sm rounded-lg text-text-primary outline-none placeholder:text-text-muted"
                  style={{
                    backgroundColor: "#0F172A",
                    padding: "8px 12px",
                    width: "128px",
                  }}
                />
                <button
                  onClick={handleCreateGroup}
                  disabled={!newGroupName.trim()}
                  className="font-mono text-sm rounded-lg transition-colors disabled:opacity-50"
                  style={{
                    backgroundColor: "#22D3EE",
                    color: "#0A0F1C",
                    padding: "8px 12px",
                  }}
                >
                  {t("rules.create")}
                </button>
                <button
                  onClick={() => { setShowNewGroup(false); setNewGroupName(""); }}
                  className="font-mono text-sm text-text-muted hover:text-text-secondary transition-colors"
                  style={{ padding: "8px" }}
                >
                  {t("nodes.cancel")}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNewGroup(true)}
                className="rounded-lg font-mono text-sm text-text-muted hover:text-accent transition-colors shrink-0"
                style={{
                  padding: "8px 12px",
                  border: "1px dashed rgba(100,116,139,0.3)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#22D3EE"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(100,116,139,0.3)"; }}
              >
                + {t("rules.new_group")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Default Strategy card */}
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
          {(["direct", "proxy"] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => handleStrategyChange(opt)}
              aria-pressed={strategy === opt}
              className="font-mono transition-colors rounded-md"
              style={{
                fontSize: "12px",
                padding: "6px 14px",
                backgroundColor: strategy === opt ? "#22D3EE" : "transparent",
                color: strategy === opt ? "#0A0F1C" : "#64748B",
              }}
            >
              {opt === "direct" ? t("rules.direct") : t("rules.proxy")}
            </button>
          ))}
        </div>
      </div>

      {/* Built-in info bar */}
      <div className="flex items-center" style={{ gap: "6px" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span className="font-sans text-text-muted" style={{ fontSize: "11px" }}>
          {t("rules.builtin_info")}
        </span>
        <Tooltip text={t("tooltip.dns_split")} />
      </div>

      {/* Rules table */}
      <div className="bg-card rounded-xl overflow-hidden flex-1 flex flex-col">
        {/* Table header */}
        <div
          className="grid font-mono text-text-muted tracking-[2px] uppercase"
          style={{
            gridTemplateColumns: "140px 1fr 120px 40px",
            backgroundColor: "#0F172A",
            padding: "10px 16px",
            fontSize: "10px",
          }}
        >
          <span>{t("rules.type")}</span>
          <span>{t("rules.match")}</span>
          <span>{t("rules.outbound")}</span>
          <span />
        </div>

        {/* Table rows */}
        <div className="flex-1 overflow-y-auto">
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
              onMouseEnter={() => setHoveredId(rule.id)}
              onMouseLeave={() => setHoveredId(null)}
              className="grid items-center"
              style={{
                gridTemplateColumns: "140px 1fr 120px 40px",
                padding: "12px 16px",
                borderBottom: "1px solid #0F172A",
              }}
            >
              {/* Type tag */}
              <span className="flex items-center gap-1">
                <span
                  className="inline-block font-mono text-accent rounded"
                  style={{ backgroundColor: "#0F172A", fontSize: "11px", padding: "2px 8px" }}
                >
                  {RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type}
                </span>
                <Tooltip text={t(typeTooltipKey[rule.rule_type] || "")} />
              </span>

              {/* Match value */}
              <span className="font-mono text-text-primary truncate pr-4" style={{ fontSize: "13px" }}>
                {rule.match_value}
              </span>

              {/* Outbound */}
              <span className="flex items-center gap-1">
                <span
                  className="font-mono"
                  style={{
                    fontSize: "12px",
                    color: rule.outbound === "proxy" ? "#22D3EE" : "#94A3B8",
                  }}
                >
                  {OUTBOUND_LABELS[rule.outbound] ?? rule.outbound}
                </span>
                <Tooltip text={t(outboundTooltipKey[rule.outbound] || "")} />
              </span>

              {/* Delete button */}
              <div className="flex justify-center">
                {hoveredId === rule.id && (
                  <button
                    onClick={() => handleDelete(rule.id)}
                    aria-label={`Delete rule for ${rule.match_value}`}
                    className="text-text-muted hover:text-red-400 transition-colors"
                  >
                    <XIcon />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {showAdd && (
        <AddRuleDialog onClose={() => setShowAdd(false)} onAdd={handleAddRule} />
      )}
    </div>
  );
}
