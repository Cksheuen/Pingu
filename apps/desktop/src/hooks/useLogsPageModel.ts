import { useEffect, useRef, useState, type RefObject } from "react";
import { clearLogs, getLogFilePath, getLogs } from "../lib/logs-api";
import type { LogEntry } from "../lib/types";
import { useI18nRerender } from "./useI18nRerender";

interface LogsPageModel {
  logs: LogEntry[];
  logPath: string;
  containerRef: RefObject<HTMLDivElement | null>;
  handleClear: () => Promise<void>;
}

export function useLogsPageModel(): LogsPageModel {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logPath, setLogPath] = useState("");
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useI18nRerender();

  useEffect(() => {
    const fetchLogs = () => {
      getLogs().then((entries) => {
        if (clearedAt) {
          setLogs(entries.filter((entry) => entry.timestamp > clearedAt));
          return;
        }
        setLogs(entries);
      });
    };

    fetchLogs();
    getLogFilePath().then(setLogPath);

    const id = setInterval(fetchLogs, 2000);
    return () => clearInterval(id);
  }, [clearedAt]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

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
    containerRef,
    handleClear,
  };
}
