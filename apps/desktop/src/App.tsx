import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Home from "./pages/Home";
import Nodes from "./pages/Nodes";
import Rules from "./pages/Rules";
import Logs from "./pages/Logs";
import HostOverrides from "./pages/HostOverrides";
import Settings from "./pages/Settings";
import { useConnectionStore } from "./lib/connection-store";

// Rendered inside BrowserRouter so useLocation is available; keying the
// wrapper by pathname replays the page-enter animation on every navigation.
function RoutedContent() {
  const location = useLocation();
  return (
    <div className="page-enter" key={location.pathname}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/nodes" element={<Nodes />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/host-overrides" element={<HostOverrides />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}

export default function App() {
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

    const poll = async () => {
      await refreshStatus().catch(() => undefined);
      if (!stopped) timer = setTimeout(poll, 1000);
    };

    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
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
