import { useState, useEffect, useRef } from "react";
import { getLogs, clearLogs, getLogFilePath } from "../lib/api";
import type { LogEntry } from "../lib/types";
import { t, onLangChange } from "../lib/i18n";

function levelStyle(level: string) {
  switch (level.toLowerCase()) {
    case "warn":
    case "warning":
      return "text-amber-400 bg-amber-400/10";
    case "error":
      return "text-red-400 bg-red-400/10";
    default:
      return "text-accent bg-accent/10";
  }
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

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logPath, setLogPath] = useState("");
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [, rerender] = useState(0);

  useEffect(() => onLangChange(() => rerender((n) => n + 1)), []);

  useEffect(() => {
    const fetchLogs = () => {
      getLogs().then((entries) => {
        if (clearedAt) {
          setLogs(entries.filter((e) => e.timestamp > clearedAt));
        } else {
          setLogs(entries);
        }
      });
    };
    fetchLogs();
    getLogFilePath().then(setLogPath);
    const id = setInterval(fetchLogs, 2000);
    return () => clearInterval(id);
  }, [clearedAt]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [logs]);

  const handleClear = async () => {
    try {
      await clearLogs();
    } catch {
      // fallback to frontend filter
      if (logs.length > 0) {
        setClearedAt(logs[logs.length - 1].timestamp);
      }
    }
    setLogs([]);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ padding: "32px 40px", gap: "16px" }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
          {t("logs.title")}
        </span>
        <button
          onClick={handleClear}
          className="text-text-muted border border-text-muted/20 rounded-md px-3 py-1.5 text-xs font-mono cursor-pointer transition-colors hover:text-text-secondary hover:border-text-secondary/30"
        >
          {t("logs.clear")}
        </button>
      </div>

      {/* Log file path */}
      {logPath && (
        <div className="font-mono text-text-muted" style={{ fontSize: "11px" }}>
          {t("logs.log_path")} <span className="text-text-secondary">{logPath}</span>
        </div>
      )}

      {/* Log area */}
      <div
        ref={containerRef}
        className="flex-1 bg-card rounded-xl overflow-y-auto"
        style={{ padding: "16px" }}
      >
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="font-mono text-text-muted text-sm">{t("logs.empty")}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {logs.map((entry, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="font-mono text-text-muted shrink-0" style={{ fontSize: "11px", lineHeight: "20px" }}>
                  {formatTimestamp(entry.timestamp)}
                </span>
                <span
                  className={`font-mono shrink-0 px-2 py-0.5 rounded uppercase ${levelStyle(entry.level)}`}
                  style={{ fontSize: "10px", lineHeight: "16px" }}
                >
                  {entry.level}
                </span>
                <span className="font-mono text-xs text-text-secondary flex-1" style={{ lineHeight: "20px" }}>
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
