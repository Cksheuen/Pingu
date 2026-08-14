import { useLocale } from "../hooks/useLocale.jsx";

export function BackToTop({ backToTopRef, onClick }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      className="back-to-top"
      ref={backToTopRef}
      aria-label={t("reader.backToTop")}
      onClick={onClick}
    >
      ↑
    </button>
  );
}
