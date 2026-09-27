import { SshPanel } from "./SshPanel.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { explainSelection } from "./ai.ts";
import { ConfirmDialog, type Challenge } from "./ConfirmDialog.tsx";
import { FindBar } from "./FindBar.tsx";
import { matchAction } from "./keybindings.ts";
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
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
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

  const spawning = useRef(new Set<string>());
  const spawnFor = useCallback(async (key: string, cwd?: string) => {
    if (!isTauri() || spawning.current.has(key)) return;
    spawning.current.add(key);
    try {
      const id = await invoke<number>("pty_spawn", { rows: 24, cols: 80, cwd: cwd ?? null });
      if (!liveTabs.current.has(key)) { await invoke("pty_kill", { id }); return; }
      setTabs((current) =>
        current.map((tab) => (tab.key === key ? { ...tab, sessionId: id, status: "starting", reviewed: true } : tab)),
      );
      setStatus("Shell ready");
    } catch (error) {
      setTabs((current) =>
        current.map((tab) => (tab.key === key ? { ...tab, status: "error" } : tab)),
      );
      setStatus(`Could not start shell: ${String(error)}`);
    } finally { spawning.current.delete(key); }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("prefs_load")
      .then((wire) => setPrefs(fromWire(wire as Parameters<typeof fromWire>[0])))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const first = tabsRef.current[0];
    if (first && first.sessionId === null) void spawnFor(first.key);
  }, [spawnFor]);

  const enqueueReview = (review: Review) => {
    if (review.challenge.request_id <= (settledReviews.current.get(`${review.transport}:${review.id}`) ?? 0)) return;
    if (!tabsRef.current.some((tab) => liveTabs.current.has(tab.key) && tab.sessionId === review.id && (tab.transport ?? "pty") === review.transport)) return;
    setReviews((current) => current.some((item) => reviewKey(item) === reviewKey(review)) ? current : [...current, review]);
  };
  const enqueueRef = useRef(enqueueReview); enqueueRef.current = enqueueReview;
  useEffect(() => { setTyped(""); setReviewError(""); }, [challenge ? reviewKey(challenge) : null, modeRequest?.id]);
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
  const changeMode = async (id: number, key: string, reviewed: boolean, answer: string | null) => {
    if (confirming.current.has("mode")) return;
    confirming.current.add("mode"); setReviewBusy(true); setReviewError("");
    try {
      await invoke("pty_set_reviewed", { id, reviewed, typed: answer });
      setTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed } : tab));
      setModeRequest(null);
    } catch (error) {
      setReviewError(String(error)); setStatus(String(error));
      try {
        const snapshot = await invoke<{ reviewed: boolean }>("pty_attach", { id });
        setTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed: snapshot.reviewed } : tab));
        if (snapshot.reviewed === reviewed) setModeRequest(null);
      } catch {
        setTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed: undefined } : tab));
        setStatus("Review state unknown; reconnect or close this session before relying on review");
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

  const handleMenu = useCallback((id: string) => {
    if (id === "term.new-tab") addTab();
    if (id === "term.close-tab") closeTab(activeRef.current);
    if (id === "term.clear") activePane()?.clear();
    if (id === "term.interrupt") {
      const tab = tabsRef.current.find((item) => item.key === activeRef.current);
      if (tab?.sessionId != null) void invoke(`${tab.transport ?? "pty"}_write`, { id: tab.sessionId, data: "\u0003" }).catch((error) => setStatus(String(error)));
    }
    if (id === "term.prefs") setPrefsOpen(true);
    if (id === "term.find") setFindOpen(true);
    if (id === "term.explain") void runExplain();
  }, [addTab, closeTab]);
  handleMenuRef.current = handleMenu;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest(".prefs, [role=dialog], .findbar, .console-panel, .ssh-panel")) return;
      const action = matchAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "newTab") addTab();
      if (action === "closeTab") closeTab(activeRef.current);
      if (action === "nextTab") cycle(1);
      if (action === "prevTab") cycle(-1);
      if (action === "prefs") setPrefsOpen((open) => !open);
      if (action === "find") setFindOpen(true);
      if (action === "clear") activePane()?.clear();
      if (action === "fontLarger") persistPrefs({ ...prefsRef.current, fontSize: Math.min(22, prefsRef.current.fontSize + 1) });
      if (action === "fontSmaller") persistPrefs({ ...prefsRef.current, fontSize: Math.max(10, prefsRef.current.fontSize - 1) });
      if (action === "explain") void runExplain();
      if (action === "copy") {
        const text = activePane()?.copySelection() ?? "";
        if (text) void navigator.clipboard.writeText(text);
      }
      if (action === "paste") {
        const destination = tabsRef.current.find((tab) => tab.key === activeRef.current);
        const pane = activePane();
        void navigator.clipboard.readText().then((text) => {
          if (destination && liveTabs.current.has(destination.key) && tabsRef.current.some((tab) => tab.key === destination.key && tab.sessionId === destination.sessionId && tab.status === "running")) pane?.paste(text);
        }).catch((error) => setStatus(`Clipboard read failed: ${String(error)}`));
      }
      if (action === "interrupt" && activeTab?.sessionId != null) {
        void invoke(`${activeTab.transport ?? "pty"}_write`, { id: activeTab.sessionId, data: "\u0003" }).catch((error) => setStatus(String(error)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab?.sessionId, activeTab?.transport]);

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
        <button onClick={() => { setConsoleOpen(true); setPrefsOpen(false); setSshOpen(false); }}>Connect console</button>
        <button onClick={() => { setPrefsOpen(true); setConsoleOpen(false); setSshOpen(false); }}>Appearance</button>
        <button onClick={() => { setSshOpen(true); setConsoleOpen(false); setPrefsOpen(false); }}>SSH compatibility</button>
        <span>{status}</span>
        <span>
          {activeTab?.transport === "serial" ? `serial console · review ${activeTab.consoleConfig?.production ? "on" : "off"}` : `target unknown · ${activeTab?.reviewed === false ? "direct terminal — review off" : activeTab?.reviewed === true ? "review every submission" : "review state unknown"}`}
        </span>
        {activeTab?.transport !== "serial" && activeTab?.sessionId != null && <button disabled={reviewBusy || activeTab.status !== "running"} onClick={() => {
          if (activeTab.reviewed !== true) void changeMode(activeTab.sessionId!, activeTab.key, true, null);
          else { setTyped(""); setReviewError(""); setModeRequest({ id: activeTab.sessionId!, key: activeTab.key }); }
        }}>{activeTab.reviewed !== true ? "Enable submission review" : "Use direct terminal"}</button>}
      </footer>
      {activeTab?.transport === "serial" && activeTab.sessionId != null && <ConsoleTools profileId={activeTab.consoleConfig?.profileId ?? "generic"} onHelper={(text) => { if (activeTab.consoleConfig && activeTab.sessionId != null) setPaste({ id: activeTab.sessionId, text, config: activeTab.consoleConfig }); }} key={activeTab.sessionId} onReconnect={() => void reconnectConsole(activeTab)} id={activeTab.sessionId} disabled={activeTab.status !== "running"} onStatus={setStatus} />}
      {sshOpen && <SshPanel onClose={() => setSshOpen(false)} />}
      {consoleOpen && <ConsolePanel onConnect={connectConsole} onClose={() => setConsoleOpen(false)} />}
      {prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={persistPrefs} onClose={() => setPrefsOpen(false)} />
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
        onConfirm={() => void changeMode(modeRequest.id, modeRequest.key, false, typed)} onCancel={() => setModeRequest(null)} />}

    </div>
  );
}
