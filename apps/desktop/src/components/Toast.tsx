import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
export default function Toast({ message, onClose }: { message: string | null; onClose: () => void }) {
  useEffect(() => { if (!message) return; const timer = setTimeout(onClose, 9000); return () => clearTimeout(timer); }, [message, onClose]);
  return message ? createPortal(<div className="app-toast" role="status" aria-live="polite"><span>{message}</span><button aria-label={t("toast.close")} onClick={onClose}>×</button></div>, document.body) : null;
}
