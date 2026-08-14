import { useEffect, useState } from "react";
import { t, getLang, setLang } from "../lib/i18n";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useGateSettings } from "../hooks/useGateSettings";
import { getAutostart, setAutostart as setAutostartApi, setLanguage } from "../lib/settings-api";

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}

// Render an ISO timestamp in the user's locale without seconds; fall back to
// the raw value when it cannot be parsed.
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function Toggle({ checked, disabled, label, onClick }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="setting-toggle"
      data-state={checked ? "on" : "off"}
    >
      <span />
    </button>
  );
}

export default function Settings() {
  useI18nRerender();
  const [autostart, setAutostartState] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const currentLang = getLang();
  const gate = useGateSettings();

  useEffect(() => {
    getAutostart()
      .then((value) => setAutostartState(value))
      .catch(() => undefined)
      .finally(() => setAutostartLoading(false));
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

  const handleLangChange = async (language: "en" | "zh") => {
    setLang(language);
    try {
      await setLanguage(language);
    } catch {
      /* The display language has already changed locally. */
    }
  };

  const gateReady = Boolean(gate.settings?.configured && !gate.settings.last_error);

  return (
    <div className="page-shell settings-page">
      <header className="page-header">
        <div>
          <p className="page-kicker">{t("settings.kicker")}</p>
          <h1 className="page-title">{t("settings.workspace_title")}</h1>
          <p className="page-description">{t("settings.workspace_desc")}</p>
        </div>
      </header>

      <div className="settings-layout">
        <section className="surface settings-general">
          <div className="settings-section-head">
            <span className="section-label">{t("settings.general")}</span>
          </div>

          <div className="setting-row">
            <div>
              <strong>{t("settings.autostart")}</strong>
              <p>{t("settings.autostart_desc")}</p>
            </div>
            <Toggle
              checked={autostart}
              disabled={autostartLoading}
              label={t("settings.autostart")}
              onClick={() => void handleAutostartToggle()}
            />
          </div>

          <div className="setting-row setting-row-language">
            <div>
              <strong>{t("settings.language")}</strong>
              <p>{t("settings.language_desc")}</p>
            </div>
            <div className="language-selector" role="group" aria-label={t("settings.language")}>
              <button
                type="button"
                data-active={currentLang === "zh"}
                onClick={() => void handleLangChange("zh")}
              >
                中文
              </button>
              <button
                type="button"
                data-active={currentLang === "en"}
                onClick={() => void handleLangChange("en")}
              >
                EN
              </button>
            </div>
          </div>
        </section>

        <section className="surface settings-gate">
          <div className="settings-section-head">
            <span className="section-label">{t("settings.access_setup")}</span>
            <div
              className="status-chip"
              data-state={gate.settings?.last_error ? "attention" : gateReady ? "active" : "idle"}
            >
              <span className="status-dot" />
              <span>{gateReady ? t("settings.gate_ready") : t("settings.gate_attention")}</span>
            </div>
          </div>

          <div className="settings-gate-title">
            <div>
              <h2>{t("settings.gate")}</h2>
              <p>{t("settings.gate_desc")}</p>
            </div>
            <Toggle
              checked={Boolean(gate.settings?.enabled)}
              disabled={gate.loading || gate.saving || !gate.settings?.configured}
              label={t("settings.gate_toggle")}
              onClick={() => void gate.toggleEnabled()}
            />
          </div>

          <p className="gate-security-note">{t("settings.access_note")}</p>

          <div className="gate-link-form">
            <label htmlFor="gate-access-link">{t("settings.gate_placeholder")}</label>
            <div>
              <input
                id="gate-access-link"
                type="password"
                value={gate.accessLink}
                onChange={(event) => gate.setAccessLink(event.target.value)}
                placeholder={
                  gate.settings?.configured
                    ? t("settings.gate_replace_placeholder")
                    : t("settings.gate_placeholder")
                }
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => void gate.saveAndAuthorize()}
                disabled={gate.saving || !gate.accessLink.trim()}
                className="action-primary"
              >
                {gate.saving ? t("settings.gate_saving") : t("settings.gate_save")}
              </button>
            </div>
          </div>

          {gate.settings?.configured && (
            <div className="gate-lease-details">
              <div>
                <span>{t("settings.gate_current_ip")}</span>
                <strong>{gate.settings.last_ip ?? "—"}</strong>
              </div>
              <div>
                <span>{t("settings.gate_expires")}</span>
                <strong>
                  {gate.settings.lease_expires_at
                    ? formatDateTime(gate.settings.lease_expires_at)
                    : "—"}
                </strong>
              </div>
              <button
                type="button"
                onClick={() => void gate.renewNow()}
                disabled={gate.saving || !gate.settings.enabled}
                className="action-secondary"
              >
                {t("settings.gate_renew")}
              </button>
            </div>
          )}

          {(gate.error || gate.settings?.last_error) && (
            <p className="gate-error">{gate.error || gate.settings?.last_error}</p>
          )}
        </section>
      </div>
    </div>
  );
}
