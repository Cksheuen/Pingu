import { getLang, setLang } from "../lib/i18n";

export default function LangSwitch() {
  const lang = getLang();
  return (
    <button
      onClick={() => {
        setLang(lang === "en" ? "zh" : "en");
      }}
      className="sidebar-language"
    >
      <span>LANG</span>
      <strong>{lang === "en" ? "中文" : "EN"}</strong>
    </button>
  );
}
