import { createContext, useContext, useState, useCallback } from "react";
import { createLocale } from "../services/locale.js";

const LocaleContext = createContext(null);

export function LocaleProvider({ children }) {
  const [locale] = useState(() => createLocale());
  const [language, setLanguage] = useState(locale.language);

  const t = useCallback((key, values) => locale.t(key, values), [locale]);
  const formatDate = useCallback((value) => locale.formatDate(value), [locale]);

  const changeLanguage = useCallback((lang) => {
    locale.setLanguage(lang);
    setLanguage(locale.language);
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, t, formatDate, language, setLanguage: changeLanguage }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}
