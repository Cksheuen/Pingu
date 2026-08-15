import { useLocale } from "../hooks/useLocale";
import type { RefObject } from "react";

export interface BackToTopProps {
  backToTopRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}

export function BackToTop({ backToTopRef, onClick }: BackToTopProps) {
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
