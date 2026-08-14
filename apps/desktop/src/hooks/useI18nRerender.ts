import { useEffect, useState } from "react";
import { onLangChange } from "../lib/i18n";

export function useI18nRerender() {
  const [, rerender] = useState(0);

  useEffect(() => onLangChange(() => rerender((current) => current + 1)), []);

  return rerender;
}
