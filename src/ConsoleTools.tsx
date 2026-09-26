import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
export function ConsoleTools({ id, disabled, onStatus, onReconnect }: { onReconnect: () => void; id: number; disabled: boolean; onStatus: (message: string) => void }) {
  const [duration, setDuration] = useState(250);
  const [busy, setBusy] = useState(false);
  const control = async (action: string, value = false) => {
    setBusy(true);
    try { await invoke("serial_control", { id, action, value, duration }); onStatus(`Console: ${action} sent`); }
    catch (error) { onStatus(String(error)); } finally { setBusy(false); }
  };
  return <details className="console-tools">
    <summary>Console controls</summary>
    <div>
      <button disabled={!disabled || busy} onClick={onReconnect}>Reconnect</button>
      <label>BREAK duration (ms)<input type="number" min={50} max={2000} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>
      <button disabled={disabled || busy} onClick={() => void control("break")}>Send BREAK</button>
      <button disabled={disabled || busy} onClick={() => void control("interrupt")}>Send Ctrl+C</button>
      <button disabled={disabled || busy} onClick={() => void control("escape")}>Send Esc</button>
      <button disabled={disabled || busy} onClick={() => void control("dtr", true)}>Assert DTR</button>
      <button disabled={disabled || busy} onClick={() => void control("dtr", false)}>Clear DTR</button>
      <button disabled={disabled || busy} onClick={() => void control("rts", true)}>Assert RTS</button>
      <button disabled={disabled || busy} onClick={() => void control("rts", false)}>Clear RTS</button>
      <p>BREAK and modem lines can interrupt or reset equipment. RTS is managed by the driver when hardware flow control is enabled.</p>
    </div>
  </details>;
}
