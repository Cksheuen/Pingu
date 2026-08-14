import { useState } from "react";
import { t } from "../lib/i18n";
import { useLogsPageModel } from "../hooks/useLogsPageModel";

type LevelFilter = "all" | "info" | "warn" | "error";

const LEVEL_CHIP_KEYS: LevelFilter[] = ["all", "info", "warn", "error"];

function chipLabel(key: LevelFilter): string {
  return key === "all" ? t("logs.filter_all") : key.toUpperCase();
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((v) => String(v).padStart(2, "0"))
      .join(":");
  } catch {
    return ts;
  }
}

function matchesLevel(level: string, filter: LevelFilter): boolean {
  const normalized = level.toLowerCase();
  switch (filter) {
    case "all":
      return true;
    case "warn":
      return normalized === "warn" || normalized === "warning";
    case "error":
      return normalized === "error";
    case "info":
      // Everything that is not warn/error (info, debug, ...) counts as info.
      return normalized !== "warn" && normalized !== "warning" && normalized !== "error";
  }
}

export default function Logs() {
  const { logs, logPath, containerRef, handleClear } = useLogsPageModel();
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const visibleLogs = logs.filter((entry) => {
    if (!matchesLevel(entry.level, levelFilter)) return false;
    if (!normalizedQuery) return true;
    return (
      entry.message.toLowerCase().includes(normalizedQuery) ||
      entry.level.toLowerCase().includes(normalizedQuery)
    );
  });

  return (
    <div className="page-shell overflow-hidden">
      <header className="page-header">
        <div>
          <p className="page-kicker">{t("logs.kicker")}</p>
          <h1 className="page-title">{t("logs.title")}</h1>
          <p className="page-description">{t("logs.desc")}</p>
        </div>
        <button
          onClick={handleClear}
          className="action-secondary"
        >
          {t("logs.clear")}
        </button>
      </header>

      <div className="log-toolbar">
        {LEVEL_CHIP_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className="log-chip"
            data-active={levelFilter === key}
            onClick={() => setLevelFilter(key)}
          >
            {chipLabel(key)}
          </button>
        ))}
        <input
          type="text"
          className="log-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("logs.search_placeholder")}
        />
      </div>

      {/* Log file path */}
      {logPath && (
        <span className="log-path">
          {t("logs.log_path")} <strong>{logPath}</strong>
        </span>
      )}

      {/* Log area */}
      <div
        ref={containerRef}
        className="surface flex-1 overflow-y-auto"
        style={{ padding: "16px" }}
      >
        {visibleLogs.length === 0 ? (
          <div className="empty-state">
            <p>{t("logs.empty")}</p>
          </div>
        ) : (
          <div className="log-list">
            {visibleLogs.map((entry, i) => (
              <div key={i} className="log-row">
                <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
                <span className="log-level" data-level={entry.level.toLowerCase()}>
                  {entry.level}
                </span>
                <span className="log-message">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
