import { useLocale } from "../hooks/useLocale";

export function LocaleSwitch() {
  const { t, language, setLanguage } = useLocale();
  return (
    <div className="locale-switch" role="group" aria-label={t("locale.label")}>
      <button type="button" lang="zh" aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>
        {t("locale.zh")}
      </button>
      <button type="button" lang="en" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>
        {t("locale.en")}
      </button>
    </div>
  );
}
