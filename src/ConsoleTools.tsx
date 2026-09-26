import { vendorProfile } from "./vendors/index.ts";
import { ConsoleProfileNotes } from "./ConsoleProfileNotes.tsx";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
export function ConsoleTools({ id, disabled, onStatus, onReconnect, profileId, onHelper }: { profileId: string; onHelper: (text: string) => void; onReconnect: () => void; id: number; disabled: boolean; onStatus: (message: string) => void }) {
  const profile = vendorProfile(profileId);
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
      {profile && <details><summary>{profile.vendor} · {profile.label}</summary><ConsoleProfileNotes profile={profile} />
        {profile.helpers.map((helper) => <div key={helper.label} className="console-helper">
          <strong>{helper.label} · {helper.scope === "device" ? "Changes device configuration" : "Session setting"}</strong>
          <p>{helper.description}</p><pre>{helper.command}</pre>
          <button disabled={disabled || busy} onClick={() => onHelper(helper.command)}>Review before sending</button>
        </div>)}
      </details>}
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
