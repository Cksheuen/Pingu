import { useState } from "react";
import { Modal } from "../Modal";
import { t } from "../../lib/i18n";

interface ImportDialogProps {
  onClose: () => void;
  onImport: (uri: string) => Promise<void>;
}

export function ImportDialog({ onClose, onImport }: ImportDialogProps) {
  const [uri, setUri] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
    <Modal title={t("nodes.import_title")} onClose={onClose}>
      <textarea
        value={uri}
        onChange={(e) => setUri(e.target.value)}
        placeholder={t("nodes.import_placeholder")}
        rows={4}
        aria-label="VLESS URI"
        className="dialog-field"
      />
      {error && <p className="dialog-error">{error}</p>}
      <div className="dialog-actions">
        <button
          onClick={onClose}
          className="action-secondary"
        >
          {t("nodes.cancel")}
        </button>
        <button
          onClick={handleImport}
          disabled={loading || !uri.trim()}
          className="action-primary"
        >
          {loading ? t("nodes.importing") : t("nodes.import_btn")}
        </button>
      </div>
    </Modal>
  );
}
