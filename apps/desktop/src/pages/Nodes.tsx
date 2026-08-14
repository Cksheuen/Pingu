import { t } from "../lib/i18n";
import Tooltip from "../components/Tooltip";
import { ImportDialog } from "../components/nodes/ImportDialog";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useNodesPageModel } from "../hooks/useNodesPageModel";

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

export default function Nodes() {
  const {
    status,
    nodes,
    showImport,
    openImportDialog,
    closeImportDialog,
    activateNode,
    removeNode,
    importNodeFromUri,
  } = useNodesPageModel();
  useI18nRerender();

  return (
    <div className="page-shell overflow-hidden">
      <header className="page-header">
        <div>
          <p className="page-kicker">{t("nodes.kicker")}</p>
          <h1 className="page-title">{t("nodes.title")}</h1>
          <p className="page-description">{t("nodes.desc")}</p>
        </div>
        <button
          onClick={openImportDialog}
          className="action-primary"
        >
          <PlusIcon />
          {t("nodes.import")}
        </button>
      </header>

      {/* Node list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {nodes.length === 0 && (
          <div className="empty-state">
            <p>{t("nodes.empty")}</p>
            <button className="action-primary" onClick={openImportDialog}>
              {t("nodes.empty_cta")}
            </button>
          </div>
        )}
        {nodes.map((node) => {
          const isActive = node.id === status.active_node_id;
          return (
            <div
              key={node.id}
              onClick={() => void activateNode(node.id)}
              role="button"
              tabIndex={0}
              aria-pressed={isActive}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  if (e.key === " ") e.preventDefault();
                  void activateNode(node.id);
                }
              }}
              className="surface node-row"
              style={{
                borderColor: isActive ? "var(--color-accent)" : "var(--line)",
              }}
            >
              {/* Status dot */}
              <span
                className="rounded-full shrink-0"
                style={{
                  width: "10px",
                  height: "10px",
                  backgroundColor: isActive ? "var(--color-accent)" : "var(--color-text-muted)",
                }}
              />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="font-sans font-semibold text-text-primary truncate" style={{ fontSize: "15px" }}>
                  {node.name}
                </p>
                <span className="flex items-center gap-1" style={{ marginTop: "2px" }}>
                  <span className="font-mono text-text-secondary truncate" style={{ fontSize: "11px" }}>
                    {node.address}:{node.port}
                  </span>
                  <span className="font-mono text-text-secondary" style={{ fontSize: "11px" }}> · </span>
                  <span className="font-mono text-text-secondary" style={{ fontSize: "11px" }}>VLESS{node.security ? ` + ${node.security.toUpperCase()}` : ""}</span>
                  {node.security === "reality" && <Tooltip text={t("tooltip.reality")} />}
                </span>
              </div>

              {/* Status / actions */}
              <div className="node-row-actions">
                <span
                  className="font-mono"
                  style={{
                    fontSize: "13px",
                    color: isActive ? "var(--color-accent)" : "var(--color-text-secondary)",
                  }}
                >
                  {isActive ? t("nodes.active") : "\u2014"}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!window.confirm(t("nodes.delete_confirm"))) return;
                    void removeNode(node.id);
                  }}
                  aria-label={`Delete ${node.name}`}
                  className="table-action-button"
                >
                  <XIcon />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {showImport && (
        <ImportDialog onClose={closeImportDialog} onImport={importNodeFromUri} />
      )}
    </div>
  );
}
