import { useEffect, useState } from "react";
import { clearLogs, getLogFilePath, getLogs } from "../lib/logs-api";
import type { LogEntry } from "../lib/types";
import { useI18nRerender } from "./useI18nRerender";

const LOG_POLL_INTERVAL_MS = 5_000;

function sameLogs(left: LogEntry[], right: LogEntry[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.timestamp === right[index].timestamp &&
        entry.level === right[index].level &&
        entry.message === right[index].message,
    )
  );
}

interface LogsPageModel {
  logs: LogEntry[];
  logPath: string;
  loading: boolean;
  handleClear: () => Promise<void>;
}

export function useLogsPageModel(): LogsPageModel {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logPath, setLogPath] = useState("");
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useI18nRerender();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!stopped && document.visibilityState === "visible") {
        timer = setTimeout(fetchLogs, LOG_POLL_INTERVAL_MS);
      }
    };

    const fetchLogs = async () => {
      try {
        const entries = await getLogs();
        if (stopped) return;
        const next = clearedAt ? entries.filter((entry) => entry.timestamp > clearedAt) : entries;
        setLogs((current) => (sameLogs(current, next) ? current : next));
      } catch {
        // Keep the last successful snapshot until the next poll.
      } finally {
        if (!stopped) setLoading(false);
        schedule();
      }
    };

    void fetchLogs();
    getLogFilePath().then(path => { if (!stopped) setLogPath(path); }).catch(() => undefined);

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer) clearTimeout(timer);
      void fetchLogs();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clearedAt]);

  const handleClear = async () => {
    try {
      await clearLogs();
    } catch {
      // Keep old behavior: if backend clear fails, hide logs by timestamp filter.
      if (logs.length > 0) {
        setClearedAt(logs[logs.length - 1].timestamp);
      }
    }
    setLogs([]);
  };

  return {
    logs,
    logPath,
    loading,
    handleClear,
  };
}
