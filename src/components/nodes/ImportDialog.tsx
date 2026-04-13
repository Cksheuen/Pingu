import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";

interface ImportDialogProps {
  onClose: () => void;
  onImport: (uri: string) => Promise<void>;
}

export function ImportDialog({ onClose, onImport }: ImportDialogProps) {
  const [uri, setUri] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
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
      <div
        className="bg-card rounded-xl w-full"
        style={{ maxWidth: "500px", padding: "24px", margin: "0 16px" }}
        onClick={(e) => e.stopPropagation()}
      >
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
