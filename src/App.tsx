import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { explainSelection } from "./ai.ts";
import { ConfirmDialog, type Challenge } from "./ConfirmDialog.tsx";
import { FindBar } from "./FindBar.tsx";
import { matchAction } from "./keybindings.ts";
import { isTauri } from "./native.ts";
import { DEFAULT_PREFS, fromWire, toWire, type Prefs } from "./prefs.ts";
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
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [status, setStatus] = useState(isTauri() ? "Starting shell…" : "Desktop app required");
  const [challenge, setChallenge] = useState<{ id: number; challenge: Challenge } | null>(null);
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
  const theme = resolveTheme(prefs.theme);

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
            tab.sessionId === event.payload.id ? { ...tab, status: "exited" } : tab,
          ),
        );
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
    if (!isTauri() || !activeTab?.sessionId) return;
    void invoke<ContextInfo>("pty_context", { id: activeTab.sessionId })
      .then(setContext)
      .catch(() => setContext(null));
  }, [activeTab?.sessionId]);

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
    if (isTauri()) void invoke("prefs_save", { prefs: toWire(next) }).catch(() => undefined);
  };

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
    if (tab?.sessionId != null && isTauri()) void invoke("pty_kill", { id: tab.sessionId });
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
      if (tab?.sessionId != null) void invoke("pty_write", { id: tab.sessionId, data: "\u0003" });
    }
    if (id === "term.prefs") setPrefsOpen(true);
    if (id === "term.find") setFindOpen(true);
    if (id === "term.explain") void runExplain();
  }, [addTab, closeTab]);
  handleMenuRef.current = handleMenu;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
        void invoke("pty_write", { id: activeTab.sessionId, data: "\u0003" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab?.sessionId]);

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
              key={tab.key}
              ref={(handle) => {
                panes.current.set(tab.key, handle);
              }}
              sessionId={tab.sessionId}
              active={tab.key === activeKey}
              prefs={prefs}
              onTitle={(title) => {
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
        <span>{status}</span>
        <span>
          {context?.kube_context ? `k8s ${context.kube_context}` : "local"}
          {context?.production ? " · prod" : ""}
        </span>
      </footer>
      {prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={persistPrefs} onClose={() => setPrefsOpen(false)} />
      )}
      {challenge && (
        <ConfirmDialog
          challenge={challenge.challenge}
          typed={typed}
          onTyped={setTyped}
          onConfirm={() => {
            void invoke("pty_confirm", { id: challenge.id, typed: typed.trim() });
            setChallenge(null);
            setTyped("");
          }}
          onCancel={() => {
            void invoke("pty_confirm", { id: challenge.id, typed: null });
            setChallenge(null);
            setTyped("");
          }}
        />
      )}
    </div>
  );
}
