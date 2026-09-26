import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { consoleInput, type ConsoleConfig } from "./console.ts";
export function ConsolePaste({ id, text, config, onClose, onStatus }: { id: number; text: string; config: ConsoleConfig; onClose: () => void; onStatus: (s: string) => void }) {
  const [draft, setDraft] = useState(text);
  const [typed, setTyped] = useState("");
  const [charDelay, setCharDelay] = useState(2);
  const [lineDelay, setLineDelay] = useState(100);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [error, setError] = useState("");
  const data = consoleInput(draft, config);
  const size = new TextEncoder().encode(data).length;
  useEffect(() => {
    const off = listen<{ id: number; sent: number }>("serial:paste-progress", (e) => { if (e.payload.id === id) setSent(e.payload.sent); });
    return () => { void off.then((fn) => fn()); };
  }, [id]);
  return <div className="confirm-scrim" role="dialog" aria-modal="true" aria-label="Review console paste"><form className="confirm-card paste-card" onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setError(""); setSent(0);
    try { await invoke("serial_paste", { id, data, typed, charDelay, lineDelay }); onStatus(`Sent ${size} bytes to ${config.path}`); onClose(); }
    catch (err) { setError(String(err)); } finally { setBusy(false); }
  }}>
    <h2>Review console paste</h2><p>{config.path} · {size} bytes · {config.lineEnding.toUpperCase()} line endings</p>
    <textarea aria-label="Paste content" autoFocus rows={10} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
    <p>No trailing Enter is added. Sending starts only after review. Cancellation cannot undo bytes already sent.</p>
    <label>Delay per byte (ms)<input type="number" min={0} max={100} value={charDelay} disabled={busy} onChange={(e) => setCharDelay(Number(e.target.value))} /></label>
    <label>Delay per line (ms)<input type="number" min={0} max={2000} value={lineDelay} disabled={busy} onChange={(e) => setLineDelay(Number(e.target.value))} /></label>
    {config.production && <label>Type {config.path} to approve<input value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} /></label>}
    {busy && <p role="status">Sending: {sent} / {size} bytes</p>}
    {error && <p role="alert">{error}</p>}
    <div className="confirm-actions">
      <button type="button" onClick={() => { if (busy) void invoke("serial_cancel_paste", { id }).catch((e) => setError(String(e))); else onClose(); }}>{busy ? "Stop sending" : "Close"}</button>
      <button type="submit" disabled={busy || size === 0 || size > 65536 || (config.production && typed !== config.path)}>Send reviewed paste</button>
    </div>
  </form></div>;
}
