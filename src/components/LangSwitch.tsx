import { getLang, setLang } from "../lib/i18n";

export default function LangSwitch({ onSwitch }: { onSwitch: () => void }) {
  const lang = getLang();
  return (
    <button
      onClick={() => {
        setLang(lang === "en" ? "zh" : "en");
        onSwitch();
      }}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        color: "#64748B",
        border: "1px solid rgba(100,116,139,0.3)",
        backgroundColor: "transparent",
      }}
    >
      {lang === "en" ? "中文" : "English"}
    </button>
  );
}
