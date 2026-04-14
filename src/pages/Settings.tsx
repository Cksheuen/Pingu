import { useEffect, useState } from "react";
import { t, getLang, setLang } from "../lib/i18n";
import { useI18nRerender } from "../hooks/useI18nRerender";
import {
  getAutostart,
  setAutostart as setAutostartApi,
  setLanguage,
} from "../lib/settings-api";

export default function Settings() {
  useI18nRerender();

  const [autostart, setAutostartState] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const currentLang = getLang();

  useEffect(() => {
    getAutostart()
      .then((val) => {
        setAutostartState(val);
        setAutostartLoading(false);
      })
      .catch(() => setAutostartLoading(false));
  }, []);

  const handleAutostartToggle = async () => {
    const next = !autostart;
    setAutostartState(next);
    try {
      await setAutostartApi(next);
    } catch {
      setAutostartState(!next);
    }
  };

  const handleLangChange = async (lang: "en" | "zh") => {
    setLang(lang);
    try {
      await setLanguage(lang);
    } catch {
      /* frontend already updated */
    }
  };

  return (
    <div className="h-full overflow-y-auto" style={{ padding: "32px" }}>
      <p
        className="font-mono text-text-muted tracking-[2px] uppercase mb-6"
        style={{ fontSize: "10px" }}
      >
        {t("settings.title")}
      </p>

      {/* Autostart */}
      <div className="bg-card rounded-xl mb-4" style={{ padding: "16px" }}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-text-primary text-sm font-medium">
              {t("settings.autostart")}
            </p>
            <p className="text-text-muted text-xs mt-1">
              {t("settings.autostart_desc")}
            </p>
          </div>
          <button
            onClick={handleAutostartToggle}
            disabled={autostartLoading}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              autostart ? "bg-accent" : "bg-zinc-600"
            } ${autostartLoading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                autostart ? "translate-x-[18px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Language */}
      <div className="bg-card rounded-xl" style={{ padding: "16px" }}>
        <p className="text-text-primary text-sm font-medium">
          {t("settings.language")}
        </p>
        <p className="text-text-muted text-xs mt-1 mb-3">
          {t("settings.language_desc")}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => handleLangChange("zh")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              currentLang === "zh"
                ? "bg-accent text-white"
                : "bg-zinc-700 text-text-secondary hover:text-text-primary"
            }`}
          >
            中文
          </button>
          <button
            onClick={() => handleLangChange("en")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              currentLang === "en"
                ? "bg-accent text-white"
                : "bg-zinc-700 text-text-secondary hover:text-text-primary"
            }`}
          >
            English
          </button>
        </div>
      </div>
    </div>
  );
}
