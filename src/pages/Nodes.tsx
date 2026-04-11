import { useState, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { importNode, deleteNode, setActiveNode } from "../lib/api";
import { t, onLangChange } from "../lib/i18n";
import Tooltip from "../components/Tooltip";
import { useConnectionStore } from "../lib/connection-store";

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

interface ImportDialogProps {
  onClose: () => void;
  onImport: (uri: string) => Promise<void>;
}

function ImportDialog({ onClose, onImport }: ImportDialogProps) {
  const [uri, setUri] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleImport = async () => {
    if (!uri.trim()) return;
    setLoading(true);
    setError("");
    try {
      await onImport(uri.trim());
      onClose();
    } catch {
      setError(t("nodes.import_error"));
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
      aria-label={t("nodes.import_title")}
      onClick={onClose}
    >
      <div className="bg-card rounded-xl w-full" style={{ maxWidth: "500px", padding: "24px", margin: "0 16px" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="font-sans font-semibold text-text-primary mb-4" style={{ fontSize: "18px" }}>
          {t("nodes.import_title")}
        </h2>
        <textarea
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder={t("nodes.import_placeholder")}
          rows={4}
          aria-label="VLESS URI"
          className="w-full rounded-lg text-text-secondary resize-none outline-none font-mono"
          style={{
            backgroundColor: "#0F172A",
            border: "none",
            padding: "12px",
            fontSize: "13px",
            marginBottom: "8px",
          }}
        />
        {error && (
          <p className="text-red-400 font-mono mb-3" style={{ fontSize: "12px" }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3 mt-4">
          <button
            onClick={onClose}
            className="font-mono text-text-muted hover:text-text-secondary transition-colors"
            style={{ fontSize: "13px", padding: "8px 14px" }}
          >
            {t("nodes.cancel")}
          </button>
          <button
            onClick={handleImport}
            disabled={loading || !uri.trim()}
            className="font-mono rounded-md transition-colors disabled:opacity-50"
            style={{
              backgroundColor: "#22D3EE",
              color: "#0A0F1C",
              fontSize: "13px",
              padding: "8px 14px",
            }}
          >
            {loading ? t("nodes.importing") : t("nodes.import_btn")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Nodes() {
  const { status, nodes, refreshStatus, refreshNodes, updateStatus, setNodes } = useConnectionStore();
  const [showImport, setShowImport] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [, rerender] = useState(0);

  useEffect(() => onLangChange(() => rerender((n) => n + 1)), []);

  useEffect(() => {
    refreshNodes().catch(() => undefined);
  }, [refreshNodes]);

  const handleSetActive = async (id: string) => {
    try {
      await setActiveNode(id);
      updateStatus((s) => ({ ...s, active_node_id: id }));
    } catch {
      // ignore
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteNode(id);
      setNodes(nodes.filter((n) => n.id !== id));
      await refreshStatus();
    } catch {
      // ignore
    }
  };

  const handleImport = async (uri: string) => {
    const node = await importNode(uri);
    setNodes([...nodes, node]);
    await refreshStatus();
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ padding: "32px 40px", gap: "24px" }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
          {t("nodes.title")}
        </span>
        <button
          onClick={() => setShowImport(true)}
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
              onClick={() => handleSetActive(node.id)}
              onMouseEnter={() => setHoveredId(node.id)}
              onMouseLeave={() => setHoveredId(null)}
              role="button"
              tabIndex={0}
              aria-pressed={isActive}
              onKeyDown={(e) => e.key === "Enter" && handleSetActive(node.id)}
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
                    onClick={(e) => handleDelete(e, node.id)}
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
        <ImportDialog onClose={() => setShowImport(false)} onImport={handleImport} />
      )}
    </div>
  );
}
