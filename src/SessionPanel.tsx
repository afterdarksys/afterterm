import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { composeStty, EMPTY_STTY, STTY_CHARS, STTY_FLAGS, type SttyForm, type Tri } from "./stty.ts";
import type { Tab } from "./TabBar.tsx";
import { usePanel } from "./usePanel.ts";

export type SessionDetails = {
  id: number;
  title: string;
  program: string;
  args: string[];
  pid: number | null;
  foreground_pgid: number | null;
  start_cwd: string;
  cwd: string | null;
  rows: number;
  cols: number;
  started_at_ms: number;
  bytes_in: number;
  bytes_out: number;
  exit: number | null;
  reviewed: boolean;
  log: { path: string; bytes: number; error: string | null; active: boolean } | null;
};

export const SIGNALS = [
  ["INT", "Interrupt (SIGINT)"],
  ["TSTP", "Suspend (SIGTSTP)"],
  ["QUIT", "Quit with core dump (SIGQUIT)"],
  ["HUP", "Hang up (SIGHUP)"],
  ["TERM", "Terminate (SIGTERM)"],
] as const;
export type SignalName = typeof SIGNALS[number][0];

type Props = {
  tab: Tab;
  onClose: () => void;
  onStatus: (message: string) => void;
  onSignal: (name: SignalName) => Promise<void>;
  onReset: () => void;
  onSttyShow: () => void;
  onSend: (command: string) => void;
  onToggleLog: () => Promise<void>;
};

const bytes = (count: number) => (count < 1024 ? `${count} bytes` : count < 1048576 ? `${(count / 1024).toFixed(1)} KiB` : `${(count / 1048576).toFixed(1)} MiB`);

export function SessionPanel({ tab, onClose, onStatus, onSignal, onReset, onSttyShow, onSend, onToggleLog }: Props) {
  const panelRef = usePanel<HTMLElement>(onClose);
  const [info, setInfo] = useState<SessionDetails | null>(null);
  const [error, setError] = useState("");
  const [stty, setStty] = useState<SttyForm>(EMPTY_STTY);
  const [busy, setBusy] = useState(false);
  const pty = tab.transport !== "serial" && tab.sessionId != null;

  const refresh = () => {
    if (!pty) return;
    void invoke<SessionDetails>("pty_info", { id: tab.sessionId })
      .then((next) => { setInfo(next); setError(""); })
      .catch((reason) => setError(String(reason)));
  };
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [tab.sessionId, tab.transport]);

  // Announce once when the log stops on its own (disk error, or the disk could not keep up).
  const logError = info?.log?.error ?? null;
  const announcedLogError = useRef<string | null>(null);
  useEffect(() => {
    if (logError && logError !== announcedLogError.current) onStatus(`Session log stopped: ${logError}`);
    announcedLogError.current = logError;
  }, [logError]);

  const composed = composeStty(stty);
  const running = tab.status === "running";
  const sahHost = info && info.args[0] === "connect" ? info.args[1] : null;
  const facts: [string, string][] = info ? [
    ["Tab title", tab.title],
    ["Transport", "Local pseudo-terminal"],
    ["Program", info.program],
    ["Arguments", info.args.length ? info.args.join(" ") : "none"],
    ...(sahHost ? [["SAH host", `${sahHost} (not verified by AfterTerm)`] as [string, string]] : []),
    ["Process ID", info.pid == null ? "unknown" : String(info.pid)],
    ["Foreground process group", info.foreground_pgid == null ? "unknown" : String(info.foreground_pgid)],
    ["Current directory", info.cwd ?? `unknown (started in ${info.start_cwd})`],
    ["Size", `${info.rows} rows by ${info.cols} columns`],
    ["Started", new Date(info.started_at_ms).toLocaleString()],
    ["Bytes received from the session", bytes(info.bytes_out)],
    ["Bytes sent to the session", bytes(info.bytes_in)],
    ["Exit code", info.exit == null ? "still running" : String(info.exit)],
    ["Submission review", info.reviewed ? "on, every Enter is held for approval" : "off, direct terminal"],
    ["Session log", info.log ? `${info.log.active ? "on" : `stopped: ${info.log.error ?? "unknown reason"}`}, ${bytes(info.log.bytes)} written to ${info.log.path}` : "off"],
  ] : tab.transport === "serial" && tab.consoleConfig ? [
    ["Tab title", tab.title],
    ["Transport", "Serial console"],
    ["Device", tab.consoleConfig.path],
    ["Speed", `${tab.consoleConfig.baud} baud, ${tab.consoleConfig.data_bits} data bits, parity ${tab.consoleConfig.parity}, ${tab.consoleConfig.stop_bits} stop bits`],
    ["Flow control", tab.consoleConfig.flow_control],
    ["Submission review", tab.consoleConfig.production ? "on (production console)" : "off"],
    ["State", tab.status],
  ] : [["Tab title", tab.title], ["State", tab.status]];

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); refresh(); }
  };

  return (
    <aside ref={panelRef} className="prefs session-panel" role="dialog" aria-labelledby="session-title">
      <header>
        <h2 id="session-title" tabIndex={-1}>Session info</h2>
        <button type="button" onClick={onClose}>Close</button>
      </header>
      <section aria-labelledby="session-facts">
        <h3 id="session-facts">About this session</h3>
        <dl className="facts">
          {facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}
        </dl>
        {error && <p role="alert">{error}</p>}
      </section>

      {pty && <>
        <section aria-labelledby="session-signals">
          <h3 id="session-signals">Send a signal</h3>
          <p className="prefs-note">Signals go to the foreground process group of this tab only.</p>
          <div className="button-grid">
            {SIGNALS.map(([name, label]) => (
              <button key={name} type="button" disabled={busy || !running} onClick={() => void run(() => onSignal(name))}>{label}</button>
            ))}
          </div>
        </section>

        <section aria-labelledby="session-terminal">
          <h3 id="session-terminal">Terminal settings</h3>
          <p className="prefs-note">These buttons type a command into the session as if you typed it, followed by Enter. If the shell is in the foreground, Control-U first clears anything already typed on the command line (this assumes a readline-style shell such as bash, zsh or fish). If another program such as vim or ssh is in the foreground, you are asked to confirm first, because the text would go to that program. If submission review is on, you approve it as well.</p>
          <button type="button" disabled={!running} onClick={onReset}>Reset terminal (clears the screen and sends stty sane)</button>
          <button type="button" disabled={!running} onClick={onSttyShow}>Show current settings (sends stty -a)</button>
          <fieldset className="stty">
            <legend>Change settings with stty</legend>
            {STTY_FLAGS.map(([flag, label]) => (
              <label key={flag}>
                {label}
                <select value={stty[flag]} onChange={(event) => setStty({ ...stty, [flag]: event.target.value as Tri })}>
                  <option value="unchanged">Leave unchanged</option>
                  <option value="on">Turn on</option>
                  <option value="off">Turn off</option>
                </select>
              </label>
            ))}
            {STTY_CHARS.map(([name, label]) => (
              <label key={name}>
                {label}
                <input value={stty[name]} spellCheck={false} placeholder="Unchanged, or ^H, ^?, ^C, undef"
                  onChange={(event) => setStty({ ...stty, [name]: event.target.value })} />
              </label>
            ))}
            <p className="prefs-note" id="stty-preview">
              {"error" in composed ? composed.error : composed.command ? `Command to send: ${composed.command}` : "Nothing to change yet."}
            </p>
            <div className="palette-actions">
              <button type="button" aria-describedby="stty-preview"
                disabled={!running || !("command" in composed) || !composed.command}
                onClick={() => { if ("command" in composed && composed.command) { onSend(composed.command); setStty(EMPTY_STTY); } }}>Apply</button>
              <button type="button" onClick={() => setStty(EMPTY_STTY)}>Clear choices</button>
            </div>
          </fieldset>
        </section>

        <section aria-labelledby="session-log">
          <h3 id="session-log">Debugging</h3>
          <label className="check">
            <input type="checkbox" disabled={busy} checked={!!info?.log?.active} onChange={() => void run(onToggleLog)} />
            Log session output to a file
          </label>
          <p className="prefs-note">Appends the raw output of this tab, including escape sequences, to a file you choose. Turn it off here or with File, Log Session to File.</p>
        </section>
      </>}
      {!pty && <p className="prefs-note">Signals, stty controls and session logging apply to local terminal tabs. Use Console controls for serial BREAK and line signals.</p>}
    </aside>
  );
}
