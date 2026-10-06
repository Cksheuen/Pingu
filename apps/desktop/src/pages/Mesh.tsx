import { useEffect, useRef, useState } from "react";
import { tauriInvoke } from "../lib/tauri-invoke";
import { useSubscriptionStore } from "../lib/subscription-store";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { getLang } from "../lib/i18n";

type Settings = { enabled: boolean; allow_inbound: boolean; exposed_ports: number[]; subscription_id: string; ipv4_cidr: string };
type Peer = { id: string; name: string; addresses: string[]; online: boolean; path: string };
type Snapshot = { settings: Settings; error: string | null; proxy_port: number | null; runtime: null | {
  state: string; name: string; addresses: string[]; peers: Peer[]; allow_inbound: boolean;
  exposed_ports: number[]; inbound_connections: number;
} };
const words = (zh: string, en: string) => getLang() === "zh" ? zh : en;
const message = (error: unknown) => typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
export default function Mesh() {
  useI18nRerender();
  const subscriptions = useSubscriptionStore(s => s.subscriptions);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [source, setSource] = useState("");
  const [ports, setPorts] = useState("22, 3000, 5173");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [measures, setMeasures] = useState<Record<string, string>>({});
  const initialized = useRef(false);
  const active = useRef(true);
  async function refresh() {
    const next = await tauriInvoke<Snapshot>("get_mesh_status");
    if (!active.current) return;
    setSnapshot(next);
    if (!initialized.current) { setSource(next.settings.subscription_id); setPorts(next.settings.exposed_ports.join(", ")); initialized.current = true; }
  }
  useEffect(() => {
    active.current = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { await refresh(); if (active.current) setStatusError(""); } catch (e) { if (active.current) setStatusError(message(e)); }
      if (active.current) timer = setTimeout(poll, 5000); }
    void poll(); return () => { active.current = false; clearTimeout(timer); };
  }, []);
  async function save(change: Partial<Settings>, reconnect = false) {
    if (!snapshot) return;
    setBusy(true); setError("");
    try {
      const closing = change.enabled === false || change.allow_inbound === false;
      const selectedPorts = closing ? snapshot.settings.exposed_ports : ports.trim() ? ports.split(/[\s,，]+/).map(Number) : [];
      if (selectedPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535) || selectedPorts.length > 32)
        throw new Error(words("请输入 1–65535 的 TCP 端口，最多 32 个。", "Enter up to 32 TCP ports between 1 and 65535."));
      await tauriInvoke("configure_mesh", { reconnect, settings: { ...snapshot.settings, subscription_id: source,
        exposed_ports: [...new Set(selectedPorts)], ...change } });
    } catch (e) { setError(message(e)); }
    finally { await refresh().catch(e => setError(message(e))); setBusy(false); }
  }
  async function ping(peer: Peer) {
    const ip = peer.addresses.find(a => !a.includes(":")); if (!ip) return;
    setMeasures(prev => ({ ...prev, [peer.id]: words("测量中…", "Measuring…") }));
    try { const result = await tauriInvoke<{ path: string; latency_ms: number }>("ping_mesh_peer", { ip });
      setMeasures(prev => ({ ...prev, [peer.id]: `${result.path} · ${result.latency_ms.toFixed(1)} ms` }));
    } catch (e) { setMeasures(prev => ({ ...prev, [peer.id]: message(e) })); }
  }
  const runtime = snapshot?.runtime;
  const connected = runtime?.state === "Running";
  const inbound = runtime ? runtime.allow_inbound : snapshot?.settings.allow_inbound ?? false;
  const paths: Record<string,string> = { direct: words("直连", "Direct"), relay: words("中继", "Relay"), "peer-relay": words("设备中继", "Peer relay"), idle: words("待测量", "Not measured") };
  return <div className="page-shell mesh-page">
    <header className="page-header"><div><h1 className="page-title">{words("设备组网", "Device mesh")}</h1>
      <p>{words("通过 Pingu 访问自己的设备。优先尝试直连，无法穿透时使用加密中继。", "Reach your devices through Pingu. Direct connections are preferred, with encrypted relay fallback.")}</p></div></header>
    {(error || statusError || snapshot?.error) && <div className="network-error" role="alert">{error || statusError || snapshot?.error}</div>}
    <section className="surface mesh-card">
      <div className="mesh-row"><div><h2>{words("组网连接", "Mesh connection")}</h2><p aria-live="polite">{connected ? words("已连接", "Connected") : runtime ? runtime.state : words("未连接", "Disconnected")}</p></div>
        <span className="mesh-state" data-online={connected}>{runtime?.addresses.filter(a => !a.includes(":" )).join(" · ") || "—"}</span></div>
      <label htmlFor="mesh-source">{words("设备订阅", "Device subscription")}</label>
      <select id="mesh-source" value={source} onChange={e => setSource(e.target.value)} disabled={busy || !!runtime}>
        <option value="">{words("选择 Pingu 云端订阅", "Choose a Pingu cloud subscription")}</option>
        {subscriptions.filter(s => s.enabled && s.source_kind === "url").map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <p className="mesh-help">{words("需先在云端管理页为这台设备允许组网。每台设备使用自己的订阅。", "Allow mesh for this device in the cloud manager first. Use a separate subscription for each device.")}</p>
      <div className="mesh-actions"><button className="action-primary" disabled={busy || !snapshot || !source} onClick={() => void save({ enabled: !runtime }, !runtime)}>
        {busy ? words("处理中…", "Working…") : runtime ? words("断开组网", "Disconnect mesh") : words("连接组网", "Connect mesh")}</button></div>
    </section>
    <section className="surface mesh-card">
      <div className="mesh-row"><div><h2>{words("允许其他设备访问本机", "Allow access to this device")}</h2>
        <p>{words("首次默认关闭，选择会保存在本机。关闭时仍可访问其他设备。", "Off by default. Your choice is saved on this device. You can still reach peers while it is off.")}</p></div>
        <button type="button" role="switch" aria-checked={inbound} aria-label={words("允许其他设备访问本机", "Allow access to this device")}
          className="setting-toggle" data-state={inbound ? "on" : "off"} disabled={busy || !snapshot}
          onClick={() => void save({ allow_inbound: !inbound, enabled: snapshot?.settings.enabled ?? false })}><span /></button></div>
      <label htmlFor="mesh-ports">{words("允许访问的本机 TCP 端口", "Allowed local TCP ports")}</label>
      <div className="mesh-port-row"><input id="mesh-ports" value={ports} onChange={e => setPorts(e.target.value)} disabled={busy} placeholder="22, 3000, 5173" />
        <button className="action-secondary" disabled={busy || !snapshot} onClick={() => void save({})}>{words("保存端口", "Save ports")}</button></div>
      <p className="mesh-help">{words("例如 22 为 SSH，3000 / 5173 为开发页面。只转发到本机；关闭开关会断开现有入站连接。", "For example, 22 for SSH and 3000 / 5173 for dev pages. Ports forward only to this device. Switching off closes existing inbound connections.")}</p>
      <p>{runtime ? (runtime.allow_inbound ? words(`当前已开放：${runtime.exposed_ports.join(", ")}；入站连接 ${runtime.inbound_connections} 个`, `Open ports: ${runtime.exposed_ports.join(", ")} · ${runtime.inbound_connections} inbound connections`) : words("当前拒绝所有入站连接", "All inbound connections are blocked")) : words("组网未运行，当前没有开放端口", "Mesh is stopped; no ports are exposed")}</p>
    </section>
    <section className="surface mesh-card"><h2>{words("组网设备", "Mesh devices")}</h2>
      <p className="mesh-help">{words("浏览器访问设备 IP 前，请连接 Pingu 代理。终端 SSH 使用下方命令，将 USER 替换为远端用户名。", "Connect the Pingu proxy before opening a peer IP in your browser. For SSH, use the command below and replace USER with the remote username.")}</p>
      {runtime?.peers.length ? runtime.peers.map(peer => {
        const ip = peer.addresses.find(a => !a.includes(":"));
        return <article className="mesh-peer" key={peer.id}><div className="mesh-row"><div><strong>{peer.name}</strong><p><code>{ip}</code> · {peer.online ? words("在线", "Online") : words("离线", "Offline")} · {paths[peer.path] || peer.path}</p></div>
          <button className="action-secondary" disabled={busy || !peer.online} onClick={() => void ping(peer)}>{words("检测路径", "Check path")}</button></div>
          {measures[peer.id] && <p aria-live="polite">{measures[peer.id]}</p>}
          {snapshot?.proxy_port && ip && <code className="mesh-command">{`ssh -o 'ProxyCommand=nc -X 5 -x 127.0.0.1:${snapshot.proxy_port} %h %p' USER@${ip}`}</code>}
        </article>;
      }) : <p>{words("连接后将显示已授权的其他设备。", "Other authorized devices appear after connecting.")}</p>}
    </section>
  </div>;
}
