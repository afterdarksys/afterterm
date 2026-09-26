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

type ContextInfo = {
  kube_context?: string | null;
  kube_namespace?: string | null;
  aws_profile?: string | null;
  production: boolean;
};

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
  const [challenge, setChallenge] = useState<{ id: number; challenge: Challenge; transport?: "pty" | "serial" } | null>(null);
  const [typed, setTyped] = useState("");
  const [context, setContext] = useState<ContextInfo | null>(null);
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
      setTabs((current) =>
        current.map((tab) => (tab.key === key ? { ...tab, sessionId: id, status: "running" } : tab)),
      );
      setStatus("Shell ready");
    } catch (error) {
      setTabs((current) =>
        current.map((tab) => (tab.key === key ? { ...tab, status: "error" } : tab)),
      );
      spawning.current.delete(key);
      setStatus(`Could not start shell: ${String(error)}`);
    }
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

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = Promise.all([
      listen<{ id: number; challenge: Challenge }>("pty:challenge", (event) => {
        setChallenge(event.payload);
        setTyped("");
      }),
      listen<{ id: number; code: number }>("pty:exit", (event) => {
        setTabs((current) =>
          current.map((tab) =>
            tab.transport !== "serial" && tab.sessionId === event.payload.id ? { ...tab, status: "exited" } : tab,
          ),
        );
      }),
      listen<{ id: number; code: number }>("serial:exit", (event) => {
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
    if (activeTab?.transport === "serial") { setContext(null); return; }
    if (!isTauri() || !activeTab?.sessionId) return;
    void invoke<ContextInfo>("pty_context", { id: activeTab.sessionId })
      .then(setContext)
      .catch(() => setContext(null));
  }, [activeTab?.sessionId, activeTab?.transport]);

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
      if (tab.sessionId != null) await invoke("serial_close", { id: tab.sessionId });
      const config = { ...tab.consoleConfig, path };
      const id = await invoke<number>("serial_open", { config });
      if (!tabsRef.current.some((t) => t.key === tab.key)) { await invoke("serial_close", { id }); return; }
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
    setTabs((current) => [...current, tab]);
    setActiveKey(tab.key);
    void spawnFor(tab.key);
  }, [spawnFor]);

  const closeTab = useCallback((key: string) => {
    const current = tabsRef.current;
    const tab = current.find((item) => item.key === key);
    if (tab?.sessionId != null && isTauri()) void invoke(tab.transport === "serial" ? "serial_close" : "pty_kill", { id: tab.sessionId }).catch((error) => setStatus(String(error)));
    const remaining = current.filter((item) => item.key !== key);
    if (remaining.length === 0) {
      const fresh = newTab();
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
      if (event.target instanceof HTMLElement && event.target.closest(".prefs, .confirm-card, .findbar")) return;
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
        void navigator.clipboard.readText().then((text) => activePane()?.paste(text));
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
              onChallenge={(id, next) => { setChallenge({ id, challenge: next, transport: "serial" }); setTyped(""); }}
              active={tab.key === activeKey}
              prefs={prefs}
              onTitle={(title) => {
                if (tab.transport === "serial") return;
                setTabs((current) =>
                  current.map((item) => (item.key === tab.key ? { ...item, title } : item)),
                );
                if (tab.sessionId != null) void invoke("pty_set_title", { id: tab.sessionId, title });
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
          {activeTab?.transport === "serial" ? "serial console" : context?.kube_context ? `k8s ${context.kube_context}` : "local"}
          {context?.production ? " · prod" : ""}
        </span>
      </footer>
      {activeTab?.transport === "serial" && activeTab.sessionId != null && <ConsoleTools profileId={activeTab.consoleConfig?.profileId ?? "generic"} onHelper={(text) => { if (activeTab.consoleConfig && activeTab.sessionId != null) setPaste({ id: activeTab.sessionId, text, config: activeTab.consoleConfig }); }} key={activeTab.sessionId} onReconnect={() => void reconnectConsole(activeTab)} id={activeTab.sessionId} disabled={activeTab.status !== "running"} onStatus={setStatus} />}
      {sshOpen && <SshPanel onClose={() => setSshOpen(false)} />}
      {consoleOpen && <ConsolePanel onConnect={connectConsole} onClose={() => setConsoleOpen(false)} />}
      {prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={persistPrefs} onClose={() => setPrefsOpen(false)} />
      )}
      {paste && <ConsolePaste {...paste} onClose={() => setPaste(null)} onStatus={setStatus} />}
      {challenge && (
        <ConfirmDialog
          challenge={challenge.challenge}
          typed={typed}
          onTyped={setTyped}
          onConfirm={() => {
            void invoke(`${challenge.transport ?? "pty"}_confirm`, { id: challenge.id, typed: typed.trim() }).catch((error) => setStatus(String(error)));
            setChallenge(null);
            setTyped("");
          }}
          onCancel={() => {
            void invoke(`${challenge.transport ?? "pty"}_confirm`, { id: challenge.id, typed: null }).catch((error) => setStatus(String(error)));
            setChallenge(null);
            setTyped("");
          }}
        />
      )}
    </div>
  );
}
