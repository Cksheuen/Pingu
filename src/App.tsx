import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Home from "./pages/Home";
import Nodes from "./pages/Nodes";
import Rules from "./pages/Rules";
import Logs from "./pages/Logs";
import { useConnectionStore } from "./lib/connection-store";

export default function App() {
  const refreshAll = useConnectionStore((s) => s.refreshAll);

  useEffect(() => {
    refreshAll().catch(() => undefined);
  }, [refreshAll]);

  return (
    <BrowserRouter>
      <div className="flex h-screen bg-bg overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/nodes" element={<Nodes />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/logs" element={<Logs />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
