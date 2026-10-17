import { SshPanel } from "./SshPanel.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { explainSelection } from "./ai.ts";
import { ConfirmDialog, type Challenge } from "./ConfirmDialog.tsx";
import { FindBar } from "./FindBar.tsx";
import { MENU_ACTIONS, matchAction, type Action } from "./keybindings.ts";
import { readClipboard, writeClipboard } from "./clipboard.ts";
import { transcriptFileName, transcriptHtml } from "./transcript.ts";
import { SessionPanel, SIGNALS, type SessionDetails, type SignalName } from "./SessionPanel.tsx";
import { usePanel } from "./usePanel.ts";
import { isTauri } from "./native.ts";
import { DEFAULT_PREFS, fromWire, toWire, type Prefs } from "./prefs.ts";
import { reconnectPath, type ConsolePort } from "./console.ts";
import { ConsolePaste } from "./ConsolePaste.tsx";
import { ConsoleTools } from "./ConsoleTools.tsx";
import { ConsolePanel, type ConsoleConfig } from "./ConsolePanel.tsx";
import { PrefsPanel } from "./PrefsPanel.tsx";
import { TabBar, type Tab } from "./TabBar.tsx";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane.tsx";
import { resolveTheme } from "./themes.ts";

type Review = { id: number; challenge: Challenge; transport: "pty" | "serial" };
const reviewKey = (review: Review) => `${review.transport}:${review.id}:${review.challenge.request_id}`;

let tabSeq = 2;

function newTab(title = "shell"): Tab {
  return { key: `tab-${tabSeq++}`, sessionId: null, title, status: "starting" };
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { key: "tab-1", sessionId: null, title: "shell", status: "starting" },
  ]);
  const [activeKey, setActiveKey] = useState("tab-1");
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [paste, setPaste] = useState<{ id: number; text: string; config: ConsoleConfig } | null>(null);
  const [sshOpen, setSshOpen] = useState(false);
  const [sahOpen, setSahOpen] = useState(false);
  const [sahHost, setSahHost] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [printText, setPrintText] = useState("");
  const [commandRequest, setCommandRequest] = useState<{ key: string; sessionId: number; command: string; done: string; before?: () => void; group: number | null } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [status, setStatus] = useState(isTauri() ? "Starting shell…" : "Desktop app required");
  const [reviews, setReviews] = useState<Review[]>([]);
  const challenge = reviews[0] ?? null;
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const confirming = useRef(new Set<string>());
  const settledReviews = useRef(new Map<string, number>());
  const [modeRequest, setModeRequest] = useState<{ id: number; key: string } | null>(null);
  const [typed, setTyped] = useState("");
  const liveTabs = useRef(new Set(["tab-1"]));
  const panes = useRef(new Map<string, TerminalPaneHandle | null>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeKey);
  activeRef.current = activeKey;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const handleMenuRef = useRef<(id: string) => void>(() => undefined);

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
  const theme = resolveTheme(prefs.theme, prefs.themeOverrides[prefs.theme]);

  const prefsWarning = useRef("");
  const spawning = useRef(new Set<string>());
  const spawnFor = useCallback(async (key: string, cwd?: string, sahArgs?: string[]) => {
    if (!isTauri() || spawning.current.has(key)) return;
    spawning.current.add(key);
    try {
      const args = sahArgs ?? (key === "tab-1" ? await invoke<string[]>("launch_args") : []);
      const id = await invoke<number>("pty_spawn", { rows: 24, cols: 80, cwd: cwd ?? null, sahArgs: args });
      if (!liveTabs.current.has(key)) { await invoke("pty_kill", { id }); return; }
      const reviewed = prefsRef.current.reviewNewTabs;
      if (reviewed) {
        // Fail closed: a tab that was meant to start reviewed never runs unreviewed.
        try { await invoke("pty_set_reviewed", { id, reviewed: true, typed: null }); }
        catch (error) { await invoke("pty_kill", { id }).catch(() => undefined); throw error; }
      }
      setTabs((current) =>
        current.map((tab) => (tab.key === key ? { ...tab, title: args.length ? "SAH" : tab.title, sessionId: id, status: "starting", reviewed } : tab)),
      );
      setStatus(`${args.length ? "SAH client started; remote target identity is not verified by AfterTerm" : "Shell ready"}${reviewed ? "; submission review on" : ""}${prefsWarning.current ? `. ${prefsWarning.current}` : ""}`);
      prefsWarning.current = "";
    } catch (error) {
      setTabs((current) =>
        current.map((tab) => (tab.key === key ? { ...tab, status: "error" } : tab)),
      );
      setStatus(`Could not start shell: ${String(error)}`);
    } finally { spawning.current.delete(key); }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    // The first tab waits for preferences so "start new tabs reviewed" applies to it too.
    void invoke("prefs_load")
      .then((wire) => {
        const loaded = fromWire(wire as Parameters<typeof fromWire>[0]);
        prefsRef.current = loaded;
        setPrefs(loaded);
      })
      .catch((error) => {
        // Kept until the first tab announces "Shell ready", which would otherwise replace it.
        prefsWarning.current = `Preferences could not be read (${String(error)}); defaults in use, so submission review is off for new tabs`;
        setStatus(prefsWarning.current);
      })
      .finally(() => {
        const first = tabsRef.current[0];
        if (first && first.sessionId === null) void spawnFor(first.key);
      });
  }, [spawnFor]);

  const enqueueReview = (review: Review) => {
    if (review.challenge.request_id <= (settledReviews.current.get(`${review.transport}:${review.id}`) ?? 0)) return;
    if (!tabsRef.current.some((tab) => liveTabs.current.has(tab.key) && tab.sessionId === review.id && (tab.transport ?? "pty") === review.transport)) return;
    setReviews((current) => current.some((item) => reviewKey(item) === reviewKey(review)) ? current : [...current, review]);
  };
  const enqueueRef = useRef(enqueueReview); enqueueRef.current = enqueueReview;
  useEffect(() => { setTyped(""); setReviewError(""); }, [challenge ? reviewKey(challenge) : null, modeRequest?.id, commandRequest]);
  const finishReview = async (review: Review, answer: string | null) => {
    const key = reviewKey(review);
    if (confirming.current.has(key)) return;
    confirming.current.add(key); setReviewBusy(true); setReviewError("");
    const remove = () => {
      const sessionKey = `${review.transport}:${review.id}`;
      settledReviews.current.set(sessionKey, Math.max(settledReviews.current.get(sessionKey) ?? 0, review.challenge.request_id));
      setReviews((current) => current.filter((item) => reviewKey(item) !== key));
    };
    try {
      await invoke(`${review.transport}_confirm`, { id: review.id, requestId: review.challenge.request_id, typed: answer });
      remove();
    } catch (error) {
      const message = String(error); setReviewError(message); setStatus(message);
      try {
        const pending = await invoke<Challenge | null>(`${review.transport}_review`, { id: review.id });
        if (!pending || pending.request_id !== review.challenge.request_id) {
          remove();
          if (pending) enqueueRef.current({ ...review, challenge: pending });
        }
      } catch { setReviewError(`${message}. Could not reconcile the session; retry this request or close the tab.`); }
    } finally { confirming.current.delete(key); setReviewBusy(false); }
  };
  /** Resolves true only when the session is known to be in the requested mode. */
  const changeMode = async (id: number, key: string, reviewed: boolean, answer: string | null): Promise<boolean> => {
    if (confirming.current.has("mode")) return false;
    confirming.current.add("mode"); setReviewBusy(true); setReviewError("");
    try {
      await invoke("pty_set_reviewed", { id, reviewed, typed: answer });
      setTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed } : tab));
      setModeRequest(null);
      return true;
    } catch (error) {
      setReviewError(String(error)); setStatus(String(error));
      try {
        const snapshot = await invoke<{ reviewed: boolean }>("pty_attach", { id });
        setTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed: snapshot.reviewed } : tab));
        if (snapshot.reviewed === reviewed) setModeRequest(null);
        return snapshot.reviewed === reviewed;
      } catch {
        setTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed: undefined } : tab));
        setStatus("Review state unknown; reconnect or close this session before relying on review");
        return false;
      }
    }
    finally { confirming.current.delete("mode"); setReviewBusy(false); }
  };

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = Promise.all([
      listen<{ id: number; challenge: Challenge }>("pty:challenge", (event) => {
        enqueueRef.current({ ...event.payload, transport: "pty" });
      }),
      listen<{ id: number; code: number }>("pty:exit", (event) => {
        setReviews((current) => current.filter((item) => item.transport !== "pty" || item.id !== event.payload.id));
        setModeRequest((request) => request?.id === event.payload.id ? null : request);
        setTabs((current) =>
          current.map((tab) =>
            tab.transport !== "serial" && tab.sessionId === event.payload.id ? { ...tab, status: "exited" } : tab,
          ),
        );
      }),
      listen<{ id: number; code: number }>("serial:exit", (event) => {
        setReviews((current) => current.filter((item) => item.transport !== "serial" || item.id !== event.payload.id));
        setTabs((current) => current.map((tab) => tab.transport === "serial" && tab.sessionId === event.payload.id ? { ...tab, status: "exited" } : tab));
      }),
      listen<string>("afterterm:menu", (event) => {
        handleMenuRef.current(event.payload);
      }),
    ]);
    return () => {
      void unlisten.then((list) => list.forEach((fn) => fn()));
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--ink", theme.chrome.ink);
    document.documentElement.style.setProperty("--panel", theme.chrome.panel);
    document.documentElement.style.setProperty("--line", theme.chrome.line);
    document.documentElement.style.setProperty("--text", theme.chrome.text);
    document.documentElement.style.setProperty("--muted", theme.chrome.muted);
    document.documentElement.style.setProperty("--accent", theme.chrome.accent);
    document.documentElement.style.setProperty("--danger", theme.chrome.danger);
  }, [theme]);

  const persistPrefs = (next: Prefs) => {
    setPrefs(next);
    if (isTauri()) void invoke("prefs_save", { prefs: toWire(next) }).catch((error) => setStatus(`Preferences could not be saved: ${String(error)}`));
  };

  const connectConsole = async (config: ConsoleConfig) => {
    const id = await invoke<number>("serial_open", { config });
    const tab: Tab = { ...newTab(`${config.path.split("/").pop()} · ${config.baud}${config.production ? " · prod" : ""}`), transport: "serial", consoleConfig: config, sessionId: id, status: "running" };
    liveTabs.current.add(tab.key);
    setTabs((current) => [...current, tab]);
    setActiveKey(tab.key);
    setStatus("Console connected");
  };

  const reconnecting = useRef(new Set<string>());
  const reconnectConsole = async (tab: Tab, automatic = false) => {
    if (!tab.consoleConfig || reconnecting.current.has(tab.key)) return;
    reconnecting.current.add(tab.key);
    try {
      const ports = await invoke<ConsolePort[]>("serial_ports");
      const path = reconnectPath({ ...tab.consoleConfig, autoReconnect: automatic }, ports);
      if (tab.sessionId != null) {
        await invoke("serial_close", { id: tab.sessionId });
        setReviews((current) => current.filter((item) => item.transport !== "serial" || item.id !== tab.sessionId));
      }
      const config = { ...tab.consoleConfig, path };
      const id = await invoke<number>("serial_open", { config });
      if (!liveTabs.current.has(tab.key)) { await invoke("serial_close", { id }); return; }
      setTabs((current) => current.map((t) => t.key === tab.key ? { ...t, sessionId: id, consoleConfig: config, status: "running", title: `${path.split("/").pop()} · ${config.baud}${config.production ? " · prod" : ""}` } : t));
      setStatus(`Console reconnected: ${path}`);
    } catch (error) { if (!automatic) setStatus(String(error)); }
    finally { reconnecting.current.delete(tab.key); }
  };
  const reconnectRef = useRef(reconnectConsole);
  reconnectRef.current = reconnectConsole;
  useEffect(() => {
    if (!isTauri()) return;
    const timer = window.setInterval(() => {
      for (const tab of tabsRef.current) {
        if (tab.transport === "serial" && tab.status === "exited" && tab.consoleConfig?.autoReconnect && tab.consoleConfig.identity)
          void reconnectRef.current(tab, true);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activePane = () => panes.current.get(activeRef.current) ?? null;

  const addTab = useCallback(() => {
    const tab = newTab();
    liveTabs.current.add(tab.key);
    setTabs((current) => [...current, tab]);
    setActiveKey(tab.key);
    void spawnFor(tab.key);
  }, [spawnFor]);

  const closeTab = useCallback((key: string) => {
    liveTabs.current.delete(key);
    const current = tabsRef.current;
    const tab = current.find((item) => item.key === key);
    if (tab?.sessionId != null && isTauri()) void invoke(tab.transport === "serial" ? "serial_close" : "pty_kill", { id: tab.sessionId }).catch((error) => setStatus(String(error)));
    if (tab?.sessionId != null) setReviews((items) => items.filter((item) => item.id !== tab.sessionId || item.transport !== (tab.transport ?? "pty")));
    setModeRequest((request) => request?.key === key ? null : request);
    const remaining = current.filter((item) => item.key !== key);
    if (remaining.length === 0) {
      const fresh = newTab();
      liveTabs.current.add(fresh.key);
      setTabs([fresh]);
      setActiveKey(fresh.key);
      void spawnFor(fresh.key);
      return;
    }
    setTabs(remaining);
    if (activeRef.current === key) setActiveKey(remaining[remaining.length - 1].key);
  }, [spawnFor]);

  const cycle = (delta: number) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.key === activeRef.current);
    const next = current[(index + delta + current.length) % current.length];
    if (next) setActiveKey(next.key);
  };

  const runExplain = async () => {
    const selection = activePane()?.getSelection() ?? "";
    const result = await explainSelection(selection, prefsRef.current.aiEnabled);
    setStatus(result.ok ? result.text : result.reason);
  };

  const activeTabNow = () => tabsRef.current.find((tab) => tab.key === activeRef.current) ?? null;
  const ptyTab = () => {
    const tab = activeTabNow();
    if (!tab || tab.sessionId == null || tab.transport === "serial") { setStatus("This works in local terminal tabs only"); return null; }
    return tab as Tab & { sessionId: number };
  };

  // Where an edit command goes. Text fields edit themselves; any other form control, or
  // anything inside a panel or dialog, never sends clipboard text to the (possibly hidden) terminal.
  type EditTarget =
    | { kind: "terminal" }
    | { kind: "text"; field: HTMLInputElement | HTMLTextAreaElement }
    | { kind: "number"; field: HTMLInputElement }
    | { kind: "control" };
  const editTarget = (): EditTarget => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body || element.closest(".xterm")) return { kind: "terminal" };
    if (element instanceof HTMLTextAreaElement) return { kind: "text", field: element };
    if (element instanceof HTMLInputElement && /^(text|search|url|email|tel|password|)$/.test(element.type)) return { kind: "text", field: element };
    if (element instanceof HTMLInputElement && element.type === "number") return { kind: "number", field: element };
    if (element.closest(".prefs, [role=dialog], .findbar, .console-tools") || element.matches("input, select, textarea, button, [contenteditable]")) return { kind: "control" };
    return { kind: "terminal" };
  };
  const setFieldValue = (field: HTMLInputElement, value: string) => {
    // React tracks controlled values through the native setter; an input event triggers onChange.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const editField = async (target: Exclude<EditTarget, { kind: "terminal" }>, action: Action) => {
    if (target.kind === "control") {
      setStatus("Copy and paste work in the terminal or in a text field; move focus there first");
      return;
    }
    const { field } = target;
    if (action === "selectAll") { field.select(); return; }
    if (target.kind === "number") {
      if (action === "paste") {
        const text = (await readClipboard()).trim();
        if (!/^-?\d+(\.\d+)?$/.test(text)) { setStatus("The clipboard does not hold a number; nothing pasted"); return; }
        setFieldValue(target.field, text);
        setStatus(`Pasted ${text}`);
      } else {
        await writeClipboard(field.value);
        setStatus(`Copied ${field.value}`);
      }
      return;
    }
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? start;
    if (action === "copy" || action === "cut") {
      if (start === end) { setStatus("Nothing is selected in this field"); return; }
      await writeClipboard(field.value.slice(start, end));
      if (action === "cut" && !field.readOnly) {
        field.setRangeText("", start, end, "end");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setStatus(`${action === "cut" && !field.readOnly ? "Cut" : "Copied"} ${end - start} characters`);
    }
    if (action === "paste" && !field.readOnly) {
      const text = await readClipboard();
      field.setRangeText(text, start, end, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      setStatus(`Pasted ${text.length} characters`);
    }
  };

  const copySelection = async (cut: boolean) => {
    const pane = activePane();
    const text = pane?.getSelection() ?? "";
    if (!text) { setStatus("Nothing is selected. Use Edit, Select All, or select text first"); return; }
    await writeClipboard(text);
    if (cut) {
      pane?.clearSelection();
      setStatus(`Copied ${text.length} characters and cleared the selection. Terminal output cannot be deleted, so Cut works like Copy`);
    } else setStatus(`Copied ${text.length} characters`);
  };

  const pasteClipboard = async () => {
    const destination = activeTabNow();
    const pane = activePane();
    const text = await readClipboard();
    if (!text) { setStatus("The clipboard has no text to paste"); return; }
    // Stay bound to the tab and session selected when the read started.
    if (destination && liveTabs.current.has(destination.key) && tabsRef.current.some((tab) => tab.key === destination.key && tab.sessionId === destination.sessionId && tab.status === "running")) {
      pane?.paste(text);
      setStatus(`Pasted ${text.length} characters${destination.reviewed ? "; review the held submission before it is sent" : ""}`);
    } else setStatus("Paste skipped: the session is not running");
  };

  const saveText = async (kind: "transcript" | "selection" | "html") => {
    const tab = activeTabNow();
    const pane = activePane();
    if (!tab || !pane) { setStatus("No terminal to save"); return; }
    const now = new Date();
    const text = kind === "selection" ? pane.getSelection() : pane.transcript();
    if (!text) { setStatus(kind === "selection" ? "Nothing is selected to save" : "The transcript is empty"); return; }
    const contents = kind === "html" ? transcriptHtml(text, tab.title, now) : text;
    const name = transcriptFileName(tab.title, kind === "html" ? "html" : "txt", now);
    if (!isTauri()) { setStatus("Saving needs the desktop app"); return; }
    const path = await invoke<string | null>("save_text_file", { kind, suggestedName: name, contents });
    setStatus(path ? `Saved ${kind === "selection" ? "selection" : "transcript"} to ${path}` : "Save cancelled");
  };

  const printTranscript = async () => {
    const text = activePane()?.transcript() ?? "";
    if (!text) { setStatus("The transcript is empty; nothing to print"); return; }
    setPrintText(`${activeTabNow()?.title ?? "AfterTerm"} transcript, ${new Date().toLocaleString()}\n\n${text}`);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (isTauri()) await invoke("print_page"); else window.print();
    setStatus("Print dialog opened for the transcript");
  };

  // The native print sheet renders the page after print_page returns, so the transcript is
  // removed from the DOM when printing ends (afterprint) or at the user's next key press or click.
  useEffect(() => {
    if (!printText) return;
    const clear = () => setPrintText("");
    window.addEventListener("afterprint", clear);
    window.addEventListener("keydown", clear, true);
    window.addEventListener("pointerdown", clear, true);
    return () => {
      window.removeEventListener("afterprint", clear);
      window.removeEventListener("keydown", clear, true);
      window.removeEventListener("pointerdown", clear, true);
    };
  }, [printText]);

  const sendSignal = async (name: SignalName) => {
    const tab = ptyTab();
    if (!tab) return;
    const target = await invoke<string>("pty_signal", { id: tab.sessionId, signal: name });
    setStatus(`Sent SIG${name} to ${target}`);
  };

  /**
   * Type a command into the active local tab after an explicit user action. When the shell is
   * in the foreground, Ctrl-U first clears any half-typed line (this assumes a readline-style
   * line editor, as in bash, zsh and fish). When another program is in the foreground (vim, ssh,
   * a router CLI), the text would go to that program, so the user must confirm first.
   */
  const sendCommand = async (command: string, done: string, before?: () => void) => {
    const tab = ptyTab();
    if (!tab || !activePane()) return;
    const info = await invoke<SessionDetails>("pty_info", { id: tab.sessionId });
    const shellInFront = info.pid != null && info.foreground_pgid === info.pid;
    if (!shellInFront) {
      setTyped(""); setReviewError("");
      setCommandRequest({ key: tab.key, sessionId: tab.sessionId, command, done, before, group: info.foreground_pgid });
      return;
    }
    await deliverCommand(tab.key, tab.sessionId, `\u0015${command}\n`, done, before);
  };
  const deliverCommand = async (key: string, sessionId: number, text: string, done: string, before?: () => void) => {
    const pane = panes.current.get(key);
    const tab = tabsRef.current.find((item) => item.key === key);
    if (!pane || !tab || tab.sessionId !== sessionId || tab.status !== "running") { setStatus("Not sent: that session is no longer running"); return; }
    before?.();
    const result = await pane.send(text);
    if (result === "sent") setStatus(done);
    if (result === "held") setStatus(`${done.replace(/ sent$/, "")} is held for submission review; approve it to run`);
    // "failed" was already announced by the write path.
  };
  const resetTerminal = () => {
    if (!ptyTab()) return;
    void sendCommand("stty sane", "Terminal reset and stty sane sent", () => activePane()?.reset()).catch((error) => setStatus(String(error)));
  };

  const toggleLog = async () => {
    const tab = ptyTab();
    if (!tab) return;
    const info = await invoke<SessionDetails>("pty_info", { id: tab.sessionId });
    if (info.log?.active) {
      await invoke("pty_log_stop", { id: tab.sessionId });
      setStatus(`Session log stopped: ${info.log.bytes} bytes written to ${info.log.path}`);
      return;
    }
    // A log that stopped on its own is cleared before a new one starts.
    if (info.log) await invoke("pty_log_stop", { id: tab.sessionId });
    const name = transcriptFileName(tab.title, "log", new Date());
    const path = await invoke<string | null>("pty_log_start", { id: tab.sessionId, suggestedName: name });
    setStatus(path ? `Logging session output to ${path}` : "Session log cancelled");
  };

  const toggleReview = () => {
    const tab = activeTabNow();
    if (!tab || tab.sessionId == null || tab.transport === "serial" || tab.status !== "running") { setStatus("Submission review can be changed for running local terminal tabs"); return; }
    // Announce only a confirmed change; on failure changeMode has already announced the error.
    if (tab.reviewed !== true) void changeMode(tab.sessionId, tab.key, true, null).then((ok) => { if (ok) setStatus("Submission review on for this tab"); });
    else { setTyped(""); setReviewError(""); setModeRequest({ id: tab.sessionId, key: tab.key }); }
  };

  const openPanel = (panel: "prefs" | "console" | "ssh" | "sah" | "session") => {
    setPrefsOpen(panel === "prefs"); setConsoleOpen(panel === "console"); setSshOpen(panel === "ssh");
    setSahOpen(panel === "sah"); setSessionOpen(panel === "session");
  };

  const fontSize = (size: number) => {
    persistPrefs({ ...prefsRef.current, fontSize: Math.min(22, Math.max(10, size)) });
    setStatus(`Font size ${Math.min(22, Math.max(10, size))} points`);
  };

  const runAction = async (action: Action) => {
    const target = editTarget();
    if (target.kind !== "terminal" && (action === "copy" || action === "cut" || action === "paste" || action === "selectAll")) return editField(target, action);
    const pane = activePane();
    switch (action) {
      case "newTab": return addTab();
      case "closeTab": return closeTab(activeRef.current);
      case "nextTab": return cycle(1);
      case "prevTab": return cycle(-1);
      case "copy": return copySelection(false);
      case "cut": return copySelection(true);
      case "paste": return pasteClipboard();
      case "selectAll": pane?.selectAll(); setStatus("Selected all terminal text"); return;
      case "clearSelection": pane?.clearSelection(); setStatus("Selection cleared"); return;
      case "find": setFindOpen(true); return;
      case "prefs": return prefsOpen ? setPrefsOpen(false) : openPanel("prefs");
      case "clear": pane?.clear(); setStatus("Scrollback cleared"); return;
      case "resetTerminal": return resetTerminal();
      case "fontLarger": return fontSize(prefsRef.current.fontSize + 1);
      case "fontSmaller": return fontSize(prefsRef.current.fontSize - 1);
      case "fontReset": return fontSize(13);
      case "interrupt": {
        const tab = activeTabNow();
        if (tab?.sessionId != null) await invoke(`${tab.transport ?? "pty"}_write`, { id: tab.sessionId, data: "\u0003" });
        return;
      }
      case "explain": return runExplain();
      case "saveTranscript": return saveText("transcript");
      case "saveSelection": return saveText("selection");
      case "exportHtml": return saveText("html");
      case "print": return printTranscript();
      case "logSession": return toggleLog();
      case "sessionInfo": return openPanel("session");
      case "toggleReview": return toggleReview();
      case "connectSah": return openPanel("sah");
      case "connectConsole": return openPanel("console");
      case "sshCompat": return openPanel("ssh");
    }
  };
  const runRef = useRef(runAction);
  runRef.current = runAction;
  const perform = (action: Action) => void runRef.current(action).catch((error) => setStatus(String(error)));

  // The page handles a shortcut and prevents its default, which normally stops the menu
  // accelerator. If the menu still reports the same action for that key press, ignore it once.
  const keyHandled = useRef<Action | null>(null);
  const handleMenu = (id: string) => {
    const action = MENU_ACTIONS[id];
    if (action && keyHandled.current === action) { keyHandled.current = null; return; }
    if (action) { perform(action); return; }
    const signal = /^shell\.signal-([a-z]+)$/.exec(id)?.[1]?.toUpperCase();
    if (signal && SIGNALS.some(([name]) => name === signal)) { void sendSignal(signal as SignalName).catch((error) => setStatus(String(error))); return; }
    if (id === "shell.stty-show") void sendCommand("stty -a", "Sent stty -a; the settings are in the terminal output").catch((error) => setStatus(String(error)));
    if (id === "view.prefs") openPanel("prefs");
  };
  handleMenuRef.current = handleMenu;

  useEffect(() => {
    // Any new key press or click ends the window in which a duplicate menu event is ignored.
    const clearHandled = () => { keyHandled.current = null; };
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest(".prefs, [role=dialog], .findbar, .console-panel, .ssh-panel")) return;
      const action = matchAction(event);
      if (!action) return;
      event.preventDefault();
      keyHandled.current = action;
      perform(action);
    };
    window.addEventListener("keydown", clearHandled, true);
    window.addEventListener("pointerdown", clearHandled, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", clearHandled, true);
      window.removeEventListener("pointerdown", clearHandled, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="shell">
      <TabBar
        tabs={tabs}
        activeKey={activeKey}
        onSelect={setActiveKey}
        onClose={closeTab}
        onNew={addTab}
      />
      {findOpen && (
        <FindBar
          query={findQuery}
          onQuery={setFindQuery}
          onNext={() => activePane()?.findNext(findQuery)}
          onPrev={() => activePane()?.findPrev(findQuery)}
          onClose={() => setFindOpen(false)}
        />
      )}
      <main className="stage">
        {!isTauri() && (
          <p className="browser-note">AfterTerm needs the desktop app. Run `npm run tauri dev`.</p>
        )}
        {tabs.map((tab) =>
          tab.sessionId == null ? null : (
            <TerminalPane
              key={`${tab.key}-${tab.sessionId}`}
              ref={(handle) => {
                panes.current.set(tab.key, handle);
              }}
              sessionId={tab.sessionId}
              transport={tab.transport}
              consoleConfig={tab.consoleConfig}
              onPaste={(text) => { if (tab.consoleConfig && tab.sessionId != null) setPaste({ id: tab.sessionId, text, config: tab.consoleConfig }); }}
              onChallenge={(id, next) => enqueueRef.current({ id, challenge: next, transport: tab.transport ?? "pty" })}
              onAttached={(snapshot) => setTabs((current) => current.map((item) => item.key === tab.key && item.sessionId === tab.sessionId ? { ...item, reviewed: snapshot.reviewed, status: snapshot.exit != null ? "exited" : "running" } : item))}
              active={tab.key === activeKey}
              prefs={prefs}
              onTitle={(title) => {
                if (tab.transport === "serial") return;
                setTabs((current) =>
                  current.map((item) => (item.key === tab.key ? { ...item, title } : item)),
                );
                if (tab.sessionId != null) void invoke("pty_set_title", { id: tab.sessionId, title }).catch(() => undefined);
              }}
              onStatus={setStatus}
            />
          ),
        )}
      </main>
      <footer className="status">
        <button onClick={() => openPanel("console")}>Connect console</button>
        <button onClick={() => (sahOpen ? setSahOpen(false) : openPanel("sah"))}>Connect SAH</button>
        <button onClick={() => openPanel("prefs")}>Preferences</button>
        <button onClick={() => openPanel("session")}>Session info</button>
        <button onClick={() => openPanel("ssh")}>SSH compatibility</button>
        <span role="status" aria-live="polite">{status}</span>
        <span>
          {activeTab?.transport === "serial" ? `serial console · review ${activeTab.consoleConfig?.production ? "on" : "off"}` : `target unknown · ${activeTab?.reviewed === false ? "direct terminal — review off" : activeTab?.reviewed === true ? "review every submission" : "review state unknown"}`}
        </span>
        {activeTab?.transport !== "serial" && activeTab?.sessionId != null && <button disabled={reviewBusy || activeTab.status !== "running"} onClick={toggleReview}>{activeTab.reviewed !== true ? "Enable submission review" : "Use direct terminal"}</button>}
      </footer>
      {activeTab?.transport === "serial" && activeTab.sessionId != null && <ConsoleTools profileId={activeTab.consoleConfig?.profileId ?? "generic"} onHelper={(text) => { if (activeTab.consoleConfig && activeTab.sessionId != null) setPaste({ id: activeTab.sessionId, text, config: activeTab.consoleConfig }); }} key={activeTab.sessionId} onReconnect={() => void reconnectConsole(activeTab)} id={activeTab.sessionId} disabled={activeTab.status !== "running"} onStatus={setStatus} />}
      {sshOpen && <SshPanel onClose={() => setSshOpen(false)} />}
      {sahOpen && <SahPanel host={sahHost} onHost={setSahHost} onClose={() => setSahOpen(false)} onLaunch={(title, args) => {
        const tab = newTab(title); liveTabs.current.add(tab.key);
        setTabs((current) => [...current, tab]); setActiveKey(tab.key);
        void spawnFor(tab.key, undefined, args); setSahOpen(false);
      }} />}
      {consoleOpen && <ConsolePanel onConnect={connectConsole} onClose={() => setConsoleOpen(false)} />}
      {prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={persistPrefs} onClose={() => setPrefsOpen(false)} onStatus={setStatus} />
      )}
      {sessionOpen && activeTab && (
        <SessionPanel key={activeTab.key} tab={activeTab} onClose={() => setSessionOpen(false)}
          onSignal={(name) => sendSignal(name).catch((error) => setStatus(String(error)))}
          onReset={resetTerminal}
          onSttyShow={() => void sendCommand("stty -a", "Sent stty -a; the settings are in the terminal output").catch((error) => setStatus(String(error)))}
          onSend={(command) => void sendCommand(command, `${command} sent`).catch((error) => setStatus(String(error)))}
          onStatus={setStatus}
          onToggleLog={() => toggleLog().catch((error) => setStatus(String(error)))} />
      )}
      {paste && <ConsolePaste {...paste} onClose={() => setPaste(null)} onStatus={setStatus} />}
      {challenge && !modeRequest && (
        <ConfirmDialog key={reviewKey(challenge)} challenge={challenge.challenge} typed={typed} onTyped={setTyped}
          busy={reviewBusy} error={reviewError}
          onConfirm={() => void finishReview(challenge, typed.trim())}
          onCancel={() => void finishReview(challenge, null)} />
      )}
      {modeRequest && <ConfirmDialog challenge={{ request_id: 0, action: "Disable submission review?", expected: "DIRECT",
        reason: "Direct mode passes all input to the terminal, including production commands. Use it for vim, tmux and other interactive tools. AfterTerm will not review submissions in this session" }}
        typed={typed} onTyped={setTyped} busy={reviewBusy} error={reviewError}
        onConfirm={() => void changeMode(modeRequest.id, modeRequest.key, false, typed).then((ok) => { if (ok) setStatus("Submission review off; direct terminal"); })} onCancel={() => setModeRequest(null)} />}
      {commandRequest && !challenge && !modeRequest && <ConfirmDialog kicker="Send to running program" challenge={{ request_id: 0,
        action: `Send "${commandRequest.command}" to the program in the foreground?`, expected: "SEND",
        reason: `The shell is not in the foreground of this tab${commandRequest.group != null ? ` (process group ${commandRequest.group} is)` : ""}. The text and an Enter will go to that program, such as vim, ssh or a router CLI, not to your shell, and may be run there as a command`,
      }} typed={typed} onTyped={setTyped} busy={false} error=""
        onConfirm={() => { const request = commandRequest; setCommandRequest(null); void deliverCommand(request.key, request.sessionId, `${request.command}\n`, request.done, request.before).catch((error) => setStatus(String(error))); }}
        onCancel={() => { setCommandRequest(null); setStatus("Not sent"); }} />}
      <pre className="print-view" aria-hidden="true">{printText}</pre>
    </div>
  );
}

function SahPanel({ host, onHost, onClose, onLaunch }: {
  host: string; onHost: (host: string) => void; onClose: () => void; onLaunch: (title: string, args: string[]) => void;
}) {
  const panelRef = usePanel<HTMLElement>(onClose);
  const valid = /^[A-Za-z0-9._-]{1,253}$/.test(host);
  return <aside ref={panelRef} className="prefs" role="dialog" aria-labelledby="sah-title">
    <header><h2 id="sah-title" tabIndex={-1}>Connect SAH</h2><button onClick={onClose}>Close</button></header>
    <p className="prefs-note">Uses the installed sahconnect client and its server configuration. Input starts in direct mode unless new tabs start reviewed in Preferences; enable submission review from the footer or the Shell menu if you want each Enter held; AfterTerm does not verify the remote target identity.</p>
    <label>Host name or host ID<input data-autofocus value={host} onChange={(event) => onHost(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && valid) onLaunch("SAH", ["connect", host]); }} /></label>
    <button disabled={!valid} onClick={() => onLaunch("SAH", ["connect", host])}>Connect</button>
    <button onClick={() => onLaunch("SAH login", ["login"])}>Sign in to SAH</button>
  </aside>;
}
