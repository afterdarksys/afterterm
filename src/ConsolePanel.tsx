import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./native.ts";

export type ConsoleConfig = {
  path: string; baud: number; data_bits: number; parity: string;
  stop_bits: number; flow_control: string; production: boolean;
};
export function ConsolePanel({ onConnect, onClose }: {
  onConnect: (config: ConsoleConfig) => Promise<void>; onClose: () => void;
}) {
  const [config, setConfig] = useState<ConsoleConfig>({ path: "", baud: 9600, data_bits: 8, parity: "none", stop_bits: 1, flow_control: "none", production: true });
  const [ports, setPorts] = useState<{ path: string; label: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (!isTauri()) { setError("Open the desktop app to access serial devices."); return; }
    try { setPorts(await invoke("serial_ports")); setError(""); }
    catch (e) { setError(String(e)); }
  };
  useEffect(() => { void refresh(); }, []);
  return <aside className="prefs" aria-label="Serial console">
    <header><h2>Connect a console</h2><button disabled={busy} onClick={onClose} aria-label="Close console settings">×</button></header>
    <p className="prefs-note">Direct USB / serial access to switches, routers, servers, and appliances.</p>
    <form className="console-form" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await onConnect(config); onClose(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
    }}>
      <label>Detected devices<select value={ports.some((p) => p.path === config.path) ? config.path : ""} onChange={(e) => setConfig({ ...config, path: e.target.value })}>
        <option value="" disabled>Select a device or enter its path</option>
        {ports.map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}
      </select></label>
      <button type="button" onClick={() => void refresh()}>Refresh devices</button>
      <label>Device path<input required placeholder="/dev/cu.usbserial-… or /dev/ttyUSB0" value={config.path} onChange={(e) => setConfig({ ...config, path: e.target.value })} /></label>
      <label>Baud rate<input type="number" required min={1} max={4000000} value={config.baud} onChange={(e) => setConfig({ ...config, baud: Number(e.target.value) })} /></label>
      <label>Data bits<select value={config.data_bits} onChange={(e) => setConfig({ ...config, data_bits: Number(e.target.value) })}>{[5, 6, 7, 8].map((n) => <option key={n}>{n}</option>)}</select></label>
      <label>Parity<select value={config.parity} onChange={(e) => setConfig({ ...config, parity: e.target.value })}>{["none", "even", "odd"].map((v) => <option key={v}>{v}</option>)}</select></label>
      <label>Stop bits<select value={config.stop_bits} onChange={(e) => setConfig({ ...config, stop_bits: Number(e.target.value) })}><option>1</option><option>2</option></select></label>
      <label>Flow control<select value={config.flow_control} onChange={(e) => setConfig({ ...config, flow_control: e.target.value })}>{["none", "hardware", "software"].map((v) => <option key={v}>{v}</option>)}</select></label>
      <label className="check"><input type="checkbox" checked={config.production} onChange={(e) => setConfig({ ...config, production: e.target.checked })} />Production console: review every Enter</label>
      <p className="prefs-note">Starts at 9600 / 8N1, no flow control. Match the device’s console settings and cable. Enter sends CR; received bytes render directly.</p>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || !isTauri()} type="submit">{busy ? "Connecting…" : "Connect console"}</button>
    </form>
  </aside>;
}
