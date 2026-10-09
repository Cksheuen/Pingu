import { Modal } from "./Modal";
import { useConfirmation } from "../lib/confirm-action";
import { t } from "../lib/i18n";

export function ConfirmationDialog() {
  const { message, finish } = useConfirmation();
  if (!message || !finish) return null;
  return <Modal title={message} onClose={() => finish(false)}>
    <div className="dialog-actions">
      <button className="action-secondary" onClick={() => finish(false)}>{t("network.cancel")}</button>
      <button className="action-primary" onClick={() => finish(true)}>{t("confirmation.accept")}</button>
    </div>
  </Modal>;
}
