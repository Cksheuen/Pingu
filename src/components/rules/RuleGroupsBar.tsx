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
            <button
              key={group.id}
              onClick={() => {
                if (!isEditing) void onSwitchGroup(group.id);
              }}
              className="flex items-center rounded-lg font-mono text-sm transition-colors shrink-0"
              style={{
                backgroundColor: isActive ? "#22D3EE" : "#0F172A",
                color: isActive ? "#0A0F1C" : "#64748B",
                padding: "8px 16px",
                fontWeight: isActive ? 600 : 500,
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = "#CBD5E1";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = "#64748B";
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
                            void handleDeleteGroup(group.id);
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
              className="font-mono text-sm rounded-lg text-text-primary outline-none placeholder:text-text-muted"
              style={{
                backgroundColor: "#0F172A",
                padding: "8px 12px",
                width: "128px",
              }}
            />
            <button
              onClick={() => void handleCreateGroup()}
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
              onClick={() => {
                setShowNewGroup(false);
                setNewGroupName("");
              }}
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
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "#22D3EE";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "rgba(100,116,139,0.3)";
            }}
          >
            + {t("rules.new_group")}
          </button>
        )}
      </div>
    </div>
  );
}
