import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Home from "./pages/Home";
import { Sources, Routing, Activity } from "./pages/WorkspacePages";
import { useSubscriptionStore } from "./lib/subscription-store";
import Settings from "./pages/Settings";
import { useConnectionStore } from "./lib/connection-store";

const STATUS_POLL_INTERVAL_MS = 5_000;

// Rendered inside BrowserRouter so useLocation is available; keying the
// wrapper by pathname replays the page-enter animation on every navigation.
export function RoutedContent() {
  const location = useLocation();
  useEffect(() => {
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else document.querySelector(".app-main")?.scrollTo(0, 0);
  }, [location.pathname, location.hash]);
  return (
    <div className="page-enter" key={location.pathname}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/nodes" element={<Navigate to="/sources#manual-nodes" replace />} />
        <Route path="/subscriptions" element={<Navigate to="/sources#subscriptions" replace />} />
        <Route path="/chain" element={<Navigate to="/#chain" replace />} />
        <Route path="/strategies" element={<Navigate to="/#strategies" replace />} />
        <Route path="/connections" element={<Navigate to="/activity" replace />} />
        <Route path="/rules" element={<Navigate to="/routing" replace />} />
        <Route path="/host-overrides" element={<Navigate to="/routing#host-overrides" replace />} />
        <Route path="/logs" element={<Navigate to="/activity#logs" replace />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}

export default function App() {
  const refreshSubscriptions = useSubscriptionStore((s) => s.refresh);
  useEffect(() => { void refreshSubscriptions().catch(() => {}); }, [refreshSubscriptions]);
  const refreshAll = useConnectionStore((s) => s.refreshAll);
  const refreshStatus = useConnectionStore((s) => s.refreshStatus);

  useEffect(() => {
    refreshAll().catch(() => undefined);
  }, [refreshAll]);

  useEffect(() => {
    const unlisten = listen("tray-state-changed", () => {
      refreshAll().catch(() => undefined);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshAll]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!stopped && document.visibilityState === "visible") {
        timer = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
      }
    };

    const poll = async () => {
      await refreshStatus().catch(() => undefined);
      schedule();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer) clearTimeout(timer);
      void poll();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshStatus]);

  return (
    <BrowserRouter>
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <RoutedContent />
        </main>
      </div>
    </BrowserRouter>
  );
}
