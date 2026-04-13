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
    hoveredId,
    openImportDialog,
    closeImportDialog,
    setHoveredId,
    activateNode,
    removeNode,
    importNodeFromUri,
  } = useNodesPageModel();
  useI18nRerender();

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ padding: "32px 40px", gap: "24px" }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
          {t("nodes.title")}
        </span>
        <button
          onClick={openImportDialog}
          className="flex items-center gap-1.5 rounded-md font-mono font-medium transition-colors hover:opacity-90"
          style={{
            backgroundColor: "#22D3EE",
            color: "#0A0F1C",
            fontSize: "13px",
            padding: "8px 14px",
          }}
        >
          <PlusIcon />
          {t("nodes.import")}
        </button>
      </div>

      {/* Node list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {nodes.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <p className="font-mono text-text-muted" style={{ fontSize: "13px" }}>
              {t("nodes.empty")}
            </p>
          </div>
        )}
        {nodes.map((node) => {
          const isActive = node.id === status.active_node_id;
          return (
            <div
              key={node.id}
              onClick={() => void activateNode(node.id)}
              onMouseEnter={() => setHoveredId(node.id)}
              onMouseLeave={() => setHoveredId(null)}
              role="button"
              tabIndex={0}
              aria-pressed={isActive}
              onKeyDown={(e) => {
                if (e.key === "Enter") void activateNode(node.id);
              }}
              className="flex items-center gap-3 bg-card rounded-xl cursor-pointer transition-all"
              style={{
                padding: "16px",
                border: isActive ? "1px solid #22D3EE" : "1px solid transparent",
              }}
            >
              {/* Status dot */}
              <span
                className="rounded-full shrink-0"
                style={{
                  width: "10px",
                  height: "10px",
                  backgroundColor: isActive ? "#22D3EE" : "#64748B",
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

              {/* Latency / actions */}
              <div className="flex items-center gap-3 shrink-0">
                <span
                  className="font-mono"
                  style={{
                    fontSize: "13px",
                    color: isActive ? "#22D3EE" : "#94A3B8",
                  }}
                >
                  {isActive ? t("nodes.active") : "\u2014"}
                </span>
                {hoveredId === node.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeNode(node.id);
                    }}
                    aria-label={`Delete ${node.name}`}
                    className="text-text-muted hover:text-red-400 transition-colors"
                  >
                    <XIcon />
                  </button>
                )}
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
