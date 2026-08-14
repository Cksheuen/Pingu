import { useState } from "react";
import type { RuleGroup } from "../../lib/types";
import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

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

interface RuleGroupsBarProps {
  groups: RuleGroup[];
  activeGroupId: string;
  onSwitchGroup: (id: string) => Promise<void>;
  onCreateGroup: (name: string) => Promise<void>;
  onRenameGroup: (id: string, name: string) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
}

export function RuleGroupsBar({
  groups,
  activeGroupId,
  onSwitchGroup,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
}: RuleGroupsBarProps) {
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  if (groups.length === 0) {
    return null;
  }

  async function handleCreateGroup() {
    const trimmed = newGroupName.trim();
    if (!trimmed) return;

    await onCreateGroup(trimmed);
    setNewGroupName("");
    setShowNewGroup(false);
  }

  async function handleRenameGroup(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditingGroupId(null);
      setEditingName("");
      return;
    }

    await onRenameGroup(id, trimmed);
    setEditingGroupId(null);
    setEditingName("");
  }

  async function handleDeleteGroup(id: string) {
    if (!confirm(t("rules.delete_group_confirm"))) return;
    await onDeleteGroup(id);
  }

  return (
    <div className="flex items-center gap-2">
      <Tooltip text={t("tooltip.rule_groups")} />
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {groups.map((group) => {
          const isActive = group.id === activeGroupId;
          const isEditing = editingGroupId === group.id;

          return (
            <div
              key={group.id}
              className="rule-group-tab"
              data-active={isActive}
              style={{
                fontWeight: isActive ? 600 : 500,
              }}
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleRenameGroup(group.id, editingName);
                    if (e.key === "Escape") {
                      setEditingGroupId(null);
                      setEditingName("");
                    }
                  }}
                  onBlur={() => void handleRenameGroup(group.id, editingName)}
                  className="bg-transparent font-mono text-sm outline-none"
                  style={{
                    color: "var(--color-text-primary)",
                    borderBottom: "1px solid var(--line-strong)",
                    width: "96px",
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="rule-group-tab-main"
                  onClick={() => void onSwitchGroup(group.id)}
                >
                  {group.name}
                </button>
              )}
              {!isEditing && isActive && (
                <div className="rule-group-tab-actions">
                  <button
                    type="button"
                    className="rule-group-icon-action"
                    onClick={() => {
                      setEditingGroupId(group.id);
                      setEditingName(group.name);
                    }}
                    aria-label={t("rules.rename")}
                    title={t("rules.rename")}
                  >
                    <PencilIcon />
                  </button>
                  {groups.length > 1 && (
                    <button
                      type="button"
                      className="rule-group-icon-action"
                      onClick={() => void handleDeleteGroup(group.id)}
                      aria-label={t("rules.delete_group")}
                      title={t("rules.delete_group")}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {showNewGroup ? (
          <div className="flex items-center gap-2 shrink-0">
            <input
              autoFocus
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateGroup();
                if (e.key === "Escape") {
                  setShowNewGroup(false);
                  setNewGroupName("");
                }
              }}
              placeholder={t("rules.group_name_placeholder")}
              className="rule-group-input"
              style={{
                width: "128px",
              }}
            />
            <button
              type="button"
              onClick={() => void handleCreateGroup()}
              disabled={!newGroupName.trim()}
              className="action-primary"
            >
              {t("rules.create")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewGroup(false);
                setNewGroupName("");
              }}
              className="rule-group-cancel"
            >
              {t("nodes.cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowNewGroup(true)}
            className="rule-group-add"
          >
            + {t("rules.new_group")}
          </button>
        )}
      </div>
    </div>
  );
}
