import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/network-view";

/** Sequential polling; hidden/offline pages stop and superseded responses never publish. */
export function useLiveResource<T>(load: () => Promise<T>, enabled: boolean, interval = 2000, paused = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    let pending: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(null);
    setUpdatedAt(null);
    setLoading(enabled);

    const schedule = () => {
      if (!disposed && enabled && !pausedRef.current && document.visibilityState === "visible") {
        timer = setTimeout(() => { if (!pausedRef.current) void refresh(); }, interval);
      }
    };
    const refresh = (): Promise<void> => {
      if (disposed || !enabled) return Promise.resolve();
      if (pending) return pending;
      clearTimeout(timer);
      setLoading(true);
      pending = load().then((next) => {
        if (disposed) return;
        setData(next); setError(null); setUpdatedAt(Date.now());
      }).catch((cause: unknown) => {
        if (!disposed) setError(errorMessage(cause));
      }).finally(() => {
        pending = null;
        if (!disposed) { setLoading(false); schedule(); }
      });
      return pending;
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible" && !pausedRef.current) void refresh();
    };
    refreshRef.current = refresh;
    if (enabled) void refresh();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [load, enabled, interval]);

  useEffect(() => { if (!paused) void refreshRef.current(); }, [paused]);

  return { data, error, loading, updatedAt, refresh: useCallback(() => refreshRef.current(), []) };
}
