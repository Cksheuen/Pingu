import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { createLocale, type Language, type Locale } from "../services/locale";

export interface LocaleContextValue {
  locale: Locale;
  t: Locale["t"];
  formatDate: Locale["formatDate"];
  language: Language;
  setLanguage: (lang: string) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale] = useState(() => createLocale());
  const [language, setLanguage] = useState<Language>(locale.language);

  const t = useCallback((key: string, values?: Record<string, unknown>) => locale.t(key, values), [locale]);
  const formatDate = useCallback((value?: string | null) => locale.formatDate(value), [locale]);

  const changeLanguage = useCallback((lang: string) => {
    locale.setLanguage(lang);
    setLanguage(locale.language);
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, t, formatDate, language, setLanguage: changeLanguage }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}
