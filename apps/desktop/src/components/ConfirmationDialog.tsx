import { Modal } from "./Modal";
import { useConfirmation } from "../lib/confirm-action";
import { t } from "../lib/i18n";

export function ConfirmationDialog() {
  const { message, finish } = useConfirmation();
  if (!message || !finish) return null;
  return <Modal title={message} onClose={() => finish(false)}>
    <div className="dialog-actions">
      <button className="btn" onClick={() => finish(false)}>{t("network.cancel")}</button>
      <button className="btn btn-danger" onClick={() => finish(true)}>{t("confirmation.accept")}</button>
    </div>
  </Modal>;
}
