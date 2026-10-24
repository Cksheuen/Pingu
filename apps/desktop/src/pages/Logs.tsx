import { Menu } from "../components/Menu";
import { NetworkLoading } from "../components/network/NetworkState";
import { visibleRange } from "../lib/virtual-rows";
import { SectionHeader } from "../components/SectionHeader";
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useLogsPageModel } from "../hooks/useLogsPageModel";

type LevelFilter = "all" | "info" | "warn" | "error";

const LEVEL_CHIP_KEYS: LevelFilter[] = ["all", "info", "warn", "error"];

function chipLabel(key: LevelFilter): string {
  return key === "all" ? t("logs.filter_all") : key[0].toUpperCase() + key.slice(1);
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

// Polling replaces log objects, so expansion is tracked by content rather than identity.
const logKey = (entry: { timestamp: string; level: string; message: string }) =>
  `${entry.timestamp}\u0000${entry.level}\u0000${entry.message}`;

export default function Logs() {
  const { logs, logPath, loading, handleClear } = useLogsPageModel();
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const visibleLogs = logs.filter(
    (entry) => {
      if (!matchesLevel(entry.level, levelFilter)) return false;
      if (!normalizedQuery) return true;
      return (
        entry.message.toLowerCase().includes(normalizedQuery)
        ||
        entry.level.toLowerCase().includes(normalizedQuery)
      );
    }
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(260);
  const [unread, setUnread] = useState(false);
  const [expanded, setExpanded] = useState<(typeof logs)[number] | null>(null);
  const expandedKey = expanded && logKey(expanded);
  const jump = () => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setScrollTop(element.scrollTop);
    atBottom.current = true;
    setUnread(false);
  };
  useLayoutEffect(() => {
    if (atBottom.current) jump();
    else setUnread(logs.length > 0);
  }, [logs, loading]);
  useLayoutEffect(() => { jump(); }, [query, levelFilter]);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const range = visibleRange({ scrollTop, viewportHeight, rowHeight: 36, count: visibleLogs.length, overscan: 6 });

  return (
    <div className="workspace-section">
      <SectionHeader title={t("logs.title")}>
        {unread && <button className="btn btn-ghost" onClick={jump}>{t("logs.jump_latest")}</button>}
        <Menu label={t("lists.actions")} items={[
          { label: t("logs.clear"), tone: "danger", onSelect: () => { setExpanded(null); void handleClear(); } },
        ]} />
      </SectionHeader>
      <div className="log-toolbar">
        <div className="segmented" role="group" aria-label={t("logs.title")}>
          {LEVEL_CHIP_KEYS.map(
            (key) =>
            (
              <button
                key={key}
                type="button"
                aria-pressed={levelFilter === key}
                data-active={levelFilter === key}
                onClick={() => setLevelFilter(key)}
              >
                {chipLabel(key)}
              </button>
            )
          )}
        </div>
        <input
          type="text"
          className="log-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("logs.search_placeholder")}
          aria-label={t("logs.search_placeholder")}
        />
      </div>
      {/* Log file path */}
      {logPath
        && (
          <span className="log-path">
            {t("logs.log_path")} <strong>{logPath}</strong>
          </span>
        )}
      <div ref={containerRef} className="surface log-output" onScroll={event => {
        const element = event.currentTarget;
        setScrollTop(element.scrollTop);
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        if (atBottom.current) setUnread(false);
      }}>
        {loading ? <NetworkLoading /> : visibleLogs.length === 0 ? <div className="empty-state">
          <p>{t("logs.empty")}</p>
          <button className="btn btn-ghost" onClick={() => { setQuery(""); setLevelFilter("all"); }}>
            {t("connections.clear_filters")}
          </button>
        </div> : <div style={{ height: range.totalHeight, position: "relative" }}>
          <div style={{ transform: `translateY(${range.offsetTop}px)` }}>
            {visibleLogs.slice(range.start, range.end).map((entry, index) => <button
              key={range.start + index} type="button" className="row log-row"
              aria-expanded={expandedKey === logKey(entry)} title={entry.message}
              onClick={() => setExpanded(expandedKey === logKey(entry) ? null : entry)}
            >
              <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
              <span className="pill" data-level={entry.level.toLowerCase()}>{entry.level}</span>
              <span className="log-message">{entry.message}</span>
            </button>)}
          </div>
        </div>}
      </div>
      {expanded && <div className="section-block log-expanded">
        <p>{expanded.message}</p>
        <button className="btn btn-ghost" onClick={() => setExpanded(null)}>{t("lists.collapse")}</button>
      </div>}
    </div>
  );
}
