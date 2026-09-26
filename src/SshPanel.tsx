import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SSH_OPTIONS, sshHostConfig, type SshAlgorithms, type SshOverrides } from "./ssh.ts";
export function SshPanel({ onClose }: { onClose: () => void }) {
  const [available, setAvailable] = useState<SshAlgorithms | null>(null);
  const [error, setError] = useState("");
  const [host, setHost] = useState("");
  const [overrides, setOverrides] = useState<SshOverrides>({});
  useEffect(() => { void invoke<SshAlgorithms>("ssh_algorithms").then(setAvailable).catch((e) => setError(String(e))); }, []);
  let snippet = "";
  let hint = "";
  if (available) { try { snippet = sshHostConfig(host, overrides, available); } catch (e) { hint = String(e); } }
  return <aside className="prefs" aria-label="SSH compatibility">
    <header><h2>SSH compatibility</h2><button onClick={onClose} aria-label="Close SSH compatibility">×</button></header>
    <p className="prefs-note">For a negotiation failure, select only the algorithm named by the remote device that your client supports. Overrides apply to one host. Prefer updating the device when possible.</p>
    {available && <p className="prefs-note">Client: {available.client}. These lists show supported algorithms, including ones disabled by default.</p>}
    <label>Exact hostname / IP<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="switch.example.net" /></label>
    {(Object.keys(SSH_OPTIONS) as (keyof SshOverrides)[]).map((key) => <label key={key}>{SSH_OPTIONS[key]}<select value={overrides[key] ?? ""} disabled={!available} onChange={(e) => setOverrides({ ...overrides, [key]: e.target.value })}>
      <option value="">Use client defaults</option>{available?.[key].map((value) => <option key={value}>{value}</option>)}
    </select></label>)}
    <p className="prefs-note">Review and place this stanza before broad Host * rules in ~/.ssh/config. No configuration is changed automatically; host-key verification remains enabled. Algorithms removed from your client cannot be re-enabled here.</p>
    <textarea aria-label="Per-host OpenSSH configuration" rows={7} readOnly value={snippet} />
    {hint && <p className="prefs-note">{hint}</p>}
    <button disabled={!snippet} onClick={() => void navigator.clipboard.writeText(snippet).then(() => setError("Copied host configuration")).catch((e) => setError(String(e)))}>Copy host configuration</button>
    {error && <p role="status">{error}</p>}
  </aside>;
}
