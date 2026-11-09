import { SshPanel } from "./SshPanel.tsx";
import { sshDestination, sshPort, type SshTarget } from "./ssh.ts";
import {
  cleanConnection,
  closeInSplit,
  closeNeedsConfirm,
  connectionSaveError,
  openSplit,
  planNewTab,
  restorePlan,
  sanitizeConnections,
  selectInSplit,
  serialTitle,
  snapshotWorkspace,
  type SavedConnection,
  type SpawnRemote,
  type Split,
  type TabOrigin,
} from "./sessions.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { explainSelection } from "./ai.ts";
import { INTEGRATION_SNIPPET, type BlockRecord } from "./blocks.ts";
import { BlocksPanel } from "./BlocksPanel.tsx";
import { DrivePanel } from "./DrivePanel.tsx";
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
import { panelId, TabBar, tabId, type Tab } from "./TabBar.tsx";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane.tsx";
import { resolveTheme } from "./themes.ts";

type Review = { id: number; challenge: Challenge; transport: "pty" | "serial" };
const reviewKey = (review: Review) => `${review.transport}:${review.id}:${review.challenge.request_id}`;
const PREVIEW_CONNECTION_ID = "00000000-0000-4000-8000-000000000000";
const HOSTNAME_FALLBACK = ["localhost", "127.0.0.1", "::1"];

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
  const [sshConnectOpen, setSshConnectOpen] = useState(false);
  const [sshUser, setSshUser] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPortText, setSshPortText] = useState("");
  const [sahOpen, setSahOpen] = useState(false);
  const [sahHost, setSahHost] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [blocksBySession, setBlocksBySession] = useState<Record<number, { blocks: BlockRecord[]; selectedId: string | null }>>({});
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
  const splitRef = useRef<Split | null>(null);
  const [split, setSplit] = useState<Split | null>(null);
  const [closeAsk, setCloseAsk] = useState<{ key: string; sessionId: number } | null>(null);
  const [hostnames, setHostnames] = useState<string[]>(HOSTNAME_FALLBACK);
  const hostnamesRef = useRef(hostnames);
  hostnamesRef.current = hostnames;
  const [booted, setBooted] = useState(() => !isTauri());
  const allowLaunchArgs = useRef(true);
  const workspaceWarned = useRef(false);
  const finishedCounts = useRef(new Map<number, number>());
  const openSerialRef = useRef<(key: string, config: ConsoleConfig, exitSplit: boolean) => Promise<boolean>>(async () => false);
  const dropTabRef = useRef<(key: string) => void>(() => undefined);

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
  const theme = resolveTheme(prefs.theme, prefs.themeOverrides[prefs.theme]);

  const prefsWarning = useRef("");
  const spawning = useRef(new Set<string>());

  function commitTabs(map: (current: Tab[]) => Tab[]): void {
    setTabs((current) => {
      const mapped = map(current);
      if (mapped === current) return current;
      const live = liveTabs.current;
      const next = mapped.filter((tab) => live.has(tab.key));
      const have = new Set(next.map((tab) => tab.key));
      for (const tab of tabsRef.current) {
        if (live.has(tab.key) && !have.has(tab.key)) {
          next.push(tab);
          have.add(tab.key);
        }
      }
      tabsRef.current = next;
      return next;
    });
  }

  function applySplit(next: Split | null) {
    splitRef.current = next;
    setSplit(next);
  }

  function focusKey(key: string) {
    activeRef.current = key;
    setActiveKey(key);
  }

  /** Insert before an await. The sync write lets a close in the same gap see the tab. */
  function insertTab(tab: Tab) {
    liveTabs.current.add(tab.key);
    if (!tabsRef.current.some((item) => item.key === tab.key)) tabsRef.current = [...tabsRef.current, tab];
    setTabs((previous) => {
      const live = liveTabs.current;
      const next = previous.filter((item) => live.has(item.key));
      if (!next.some((item) => item.key === tab.key) && live.has(tab.key)) next.push(tab);
      const have = new Set(next.map((item) => item.key));
      for (const extra of tabsRef.current) {
        if (live.has(extra.key) && !have.has(extra.key)) {
          next.push(extra);
          have.add(extra.key);
        }
      }
      tabsRef.current = next;
      return next;
    });
  }

  async function planFrom(source: Tab | undefined) {
    const follow = prefsRef.current.newTabDirectory;
    const serial = source?.transport === "serial" || source?.origin?.kind === "serial";
    const origin = serial ? { kind: "serial" as const } : source?.origin ?? { kind: "local" as const };
    if (serial || origin.kind === "sah" || !follow || origin.kind === "ssh") return planNewTab({ origin, follow });
    if (typeof source?.reportedCwd === "string") return planNewTab({ origin, follow, reportedCwd: source.reportedCwd });
    if (source?.sessionId != null && isTauri()) {
      try {
        const info = await invoke<SessionDetails>("pty_info", { id: source.sessionId });
        return planNewTab({ origin, follow, ptyCwd: info.cwd });
      } catch {
        return planNewTab({ origin, follow });
      }
    }
    return planNewTab({ origin, follow });
  }

  const spawnFor = useCallback(async (key: string, cwd?: string, remote?: SpawnRemote, note?: string | null) => {
    if (!isTauri() || spawning.current.has(key) || !liveTabs.current.has(key)) return;
    spawning.current.add(key);
    try {
      const sahArgs = remote?.kind === "sah" ? remote.args : remote?.kind === "ssh" ? [] : key === "tab-1" && allowLaunchArgs.current ? await invoke<string[]>("launch_args") : [];
      if (!liveTabs.current.has(key)) return;
      const ssh = remote?.kind === "ssh" ? remote.target : null;
      const local = remote?.kind !== "ssh" && !(remote?.kind === "sah" || sahArgs.length > 0);
      const origin: TabOrigin = remote?.kind === "ssh" ? { kind: "ssh", target: remote.target } : remote?.kind === "sah" || sahArgs.length ? { kind: "sah" } : { kind: "local" };
      const spawnCwd = local ? (cwd ?? null) : null;
      commitTabs((current) => current.map((tab) => tab.key === key ? { ...tab, origin, spawnCwd } : tab));
      const id = await invoke<number>("pty_spawn", { rows: 24, cols: 80, cwd: spawnCwd, sahArgs, ssh });
      if (!liveTabs.current.has(key)) { await invoke("pty_kill", { id }); return; }
      const reviewed = prefsRef.current.reviewNewTabs;
      if (reviewed) {
        // Fail closed: a tab that was meant to start reviewed never runs unreviewed.
        try { await invoke("pty_set_reviewed", { id, reviewed: true, typed: null }); }
        catch (error) { await invoke("pty_kill", { id }).catch(() => undefined); throw error; }
      }
      const title = remote?.kind === "ssh" ? remote.title : sahArgs.length && !remote ? "SAH" : null;
      const started = remote?.kind === "ssh"
        ? "OpenSSH client started; remote target identity is not verified by AfterTerm"
        : sahArgs.length
          ? "SAH client started; remote target identity is not verified by AfterTerm"
          : "Shell ready";
      commitTabs((current) => current.map((tab) => tab.key === key ? { ...tab, title: title ?? tab.title, sessionId: id, status: "starting", reviewed } : tab));
      setStatus(`${started}${note ? `. ${note}` : ""}${reviewed ? "; submission review on" : ""}${prefsWarning.current ? `. ${prefsWarning.current}` : ""}`);
      prefsWarning.current = "";
    } catch (error) {
      commitTabs((current) => current.map((tab) => tab.key === key ? { ...tab, status: "error" } : tab));
      setStatus(`Could not start shell: ${String(error)}`);
    } finally { spawning.current.delete(key); }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancel = false;
    const boot = async () => {
      // The first await is hostnames, so a StrictMode remount cancels this pass before it creates tabs.
      try {
        const names = await invoke<unknown>("local_hostnames");
        if (cancel) return;
        const merged = Array.from(new Set(
          [...(Array.isArray(names) ? names : []), ...HOSTNAME_FALLBACK].filter((item): item is string => typeof item === "string" && item.length > 0),
        ));
        hostnamesRef.current = merged;
        setHostnames(merged);
      } catch {
        /* keep the fallback hostnames and do not change the status line */
      }
      if (cancel) return;
      try {
        const wire = await invoke("prefs_load");
        if (cancel) return;
        const loaded = fromWire(wire as Parameters<typeof fromWire>[0]);
        prefsRef.current = loaded;
        setPrefs(loaded);
      } catch (error) {
        if (cancel) return;
        // Kept until the first tab announces "Shell ready", which would otherwise replace it.
        prefsWarning.current = `Preferences could not be read (${String(error)}); defaults in use, so submission review is off for new tabs`;
        setStatus(prefsWarning.current);
      }
      if (cancel) return;
      const restore = prefsRef.current.restoreSessions;
      let file: unknown = null;
      if (restore !== "off") {
        try { file = await invoke("workspace_load"); } catch { file = null; }
      }
      if (cancel) return;
      const plan = restore === "off" ? null : restorePlan(file, restore);
      const placeholder = tabsRef.current;
      const canReplace = placeholder.length === 1 && placeholder[0]?.key === "tab-1" && placeholder[0].sessionId == null && !spawning.current.has("tab-1");
      if (plan && canReplace) {
        allowLaunchArgs.current = false;
        const restored: Tab[] = plan.tabs.map((session, index) => ({
          key: index === 0 ? "tab-1" : `tab-${tabSeq++}`,
          sessionId: null,
          title: session.title,
          status: "starting" as const,
          origin: session.kind === "ssh" && session.ssh
            ? { kind: "ssh" as const, target: session.ssh.target }
            : session.kind === "serial" ? { kind: "serial" as const } : { kind: "local" as const },
          consoleConfig: session.config ?? undefined,
          transport: session.kind === "serial" ? "serial" as const : undefined,
          spawnCwd: session.kind === "local" ? session.cwd : null,
        }));
        const active = restored[plan.active]?.key ?? restored[0].key;
        let nextSplit: Split | null = null;
        if (plan.split) {
          const left = restored[plan.split.index[0]];
          const right = restored[plan.split.index[1]];
          if (left && right && left.key !== right.key) {
            const focus: 0 | 1 = right.key === active ? 1 : left.key === active ? 0 : plan.split.focus;
            nextSplit = { orientation: plan.split.orientation, keys: [left.key, right.key], focus };
          }
        }
        liveTabs.current = new Set(restored.map((tab) => tab.key));
        tabsRef.current = restored;
        activeRef.current = active;
        splitRef.current = nextSplit;
        setTabs(restored);
        setActiveKey(active);
        setSplit(nextSplit);
        setBooted(true);
        for (const tab of restored) {
          const session = plan.tabs[restored.indexOf(tab)];
          if (session.kind === "serial" && session.config) {
            void openSerialRef.current(tab.key, session.config, false).catch((error) => {
              setStatus(String(error));
              if (liveTabs.current.has(tab.key) && tabsRef.current.find((item) => item.key === tab.key)?.sessionId == null) dropTabRef.current(tab.key);
            });
          } else if (session.kind === "ssh" && session.ssh) {
            void spawnFor(tab.key, undefined, { kind: "ssh", target: session.ssh.target, title: session.ssh.title });
          } else void spawnFor(tab.key, session.cwd ?? undefined);
        }
        return;
      }
      setBooted(true);
      for (const tab of tabsRef.current) {
        if (tab.sessionId == null && liveTabs.current.has(tab.key)) void spawnFor(tab.key);
      }
    };
    void boot();
    return () => { cancel = true; };
  }, [spawnFor]);

  useEffect(() => {
    if (!booted || !isTauri()) return;
    const timer = window.setTimeout(() => {
      const workspace = snapshotWorkspace({
        tabs: tabsRef.current,
        activeKey: activeRef.current,
        split: splitRef.current,
      });
      void invoke("workspace_save", { workspace }).catch(() => {
        if (workspaceWarned.current) return;
        workspaceWarned.current = true;
        setStatus("Workspace could not be saved");
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [tabs, split, activeKey, booted]);

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
      commitTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed } : tab));
      setModeRequest(null);
      return true;
    } catch (error) {
      setReviewError(String(error)); setStatus(String(error));
      try {
        const snapshot = await invoke<{ reviewed: boolean }>("pty_attach", { id });
        commitTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed: snapshot.reviewed } : tab));
        if (snapshot.reviewed === reviewed) setModeRequest(null);
        return snapshot.reviewed === reviewed;
      } catch {
        commitTabs((current) => current.map((tab) => tab.key === key && tab.sessionId === id ? { ...tab, reviewed: undefined } : tab));
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
        commitTabs((current) =>
          current.map((tab) =>
            tab.transport !== "serial" && tab.sessionId === event.payload.id ? { ...tab, status: "exited" } : tab,
          ),
        );
      }),
      listen<{ id: number; code: number }>("serial:exit", (event) => {
        setReviews((current) => current.filter((item) => item.transport !== "serial" || item.id !== event.payload.id));
        commitTabs((current) => current.map((tab) => tab.transport === "serial" && tab.sessionId === event.payload.id ? { ...tab, status: "exited" } : tab));
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
    prefsRef.current = next;
    setPrefs(next);
    if (isTauri()) void invoke("prefs_save", { prefs: toWire(next) }).catch((error) => setStatus(`Preferences could not be saved: ${String(error)}`));
  };

  const connectConsole = async (config: ConsoleConfig) => {
    const tab = newTab(serialTitle(config));
    insertTab(tab);
    focusKey(tab.key);
    try {
      const opened = await openSerial(tab.key, config, true);
      if (opened) setStatus("Console connected");
    } catch (error) {
      if (liveTabs.current.has(tab.key) && tabsRef.current.find((item) => item.key === tab.key)?.sessionId == null) dropTab(tab.key);
      throw error;
    }
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
      commitTabs((current) => current.map((t) => t.key === tab.key ? { ...t, sessionId: id, consoleConfig: config, status: "running", origin: { kind: "serial" }, transport: "serial", title: serialTitle(config) } : t));
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
    const source = tabsRef.current.find((tab) => tab.key === activeRef.current);
    const tab = newTab();
    applySplit(null);
    insertTab(tab);
    focusKey(tab.key);
    void (async () => {
      const plan = await planFrom(source);
      if (!liveTabs.current.has(tab.key)) return;
      void spawnFor(tab.key, plan.cwd ?? undefined, plan.remote ?? undefined, plan.note);
    })();
  }, [spawnFor]);

  const closeTab = useCallback((key: string) => {
    if (!liveTabs.current.has(key)) return;
    liveTabs.current.delete(key);
    const tab = tabsRef.current.find((item) => item.key === key);
    if (tab?.sessionId != null && isTauri()) void invoke(tab.transport === "serial" ? "serial_close" : "pty_kill", { id: tab.sessionId }).catch((error) => setStatus(String(error)));
    if (tab?.sessionId != null) {
      const id = tab.sessionId;
      setReviews((items) => items.filter((item) => item.id !== id || item.transport !== (tab.transport ?? "pty")));
      setBlocksBySession((blocks) => {
        if (!(id in blocks)) return blocks;
        const next = { ...blocks };
        delete next[id];
        return next;
      });
    }
    setModeRequest((request) => request?.key === key ? null : request);
    setCloseAsk((ask) => ask?.key === key ? null : ask);
    if (tab) setStatus(`Closed ${tab.title}`);
    const closed = closeInSplit(splitRef.current, key);
    applySplit(closed.split);
    const remaining = tabsRef.current.filter((item) => liveTabs.current.has(item.key));
    if (remaining.length === 0) {
      const fresh = newTab();
      liveTabs.current.add(fresh.key);
      tabsRef.current = [fresh];
      activeRef.current = fresh.key;
      applySplit(null);
      setTabs([fresh]);
      setActiveKey(fresh.key);
      void spawnFor(fresh.key);
      return;
    }
    tabsRef.current = remaining;
    const nextActive = closed.focusKey ?? (activeRef.current === key ? remaining[remaining.length - 1].key : null);
    if (nextActive) {
      activeRef.current = nextActive;
      setActiveKey(nextActive);
    }
    commitTabs((items) => items.filter((item) => liveTabs.current.has(item.key)));
  }, [spawnFor]);

  function dropTab(key: string) {
    if (!liveTabs.current.has(key)) return;
    liveTabs.current.delete(key);
    const closed = closeInSplit(splitRef.current, key);
    applySplit(closed.split);
    const remaining = tabsRef.current.filter((item) => liveTabs.current.has(item.key));
    if (remaining.length === 0) {
      const fresh = newTab();
      liveTabs.current.add(fresh.key);
      tabsRef.current = [fresh];
      activeRef.current = fresh.key;
      applySplit(null);
      setTabs([fresh]);
      setActiveKey(fresh.key);
      void spawnFor(fresh.key);
      return;
    }
    tabsRef.current = remaining;
    const nextActive = closed.focusKey ?? (activeRef.current === key ? remaining[remaining.length - 1].key : null);
    if (nextActive) {
      activeRef.current = nextActive;
      setActiveKey(nextActive);
    }
    commitTabs((items) => items.filter((item) => liveTabs.current.has(item.key)));
  }
  dropTabRef.current = dropTab;

  async function openSerial(key: string, config: ConsoleConfig, exitSplit: boolean): Promise<boolean> {
    const origin: TabOrigin = { kind: "serial" };
    tabsRef.current = tabsRef.current.map((tab) => tab.key === key ? { ...tab, origin, transport: "serial", consoleConfig: config } : tab);
    setTabs((current) => {
      const live = liveTabs.current;
      const next = current.filter((tab) => live.has(tab.key)).map((tab) => tab.key === key ? { ...tab, origin, transport: "serial" as const, consoleConfig: config } : tab);
      const have = new Set(next.map((tab) => tab.key));
      for (const tab of tabsRef.current) {
        if (live.has(tab.key) && !have.has(tab.key)) {
          next.push(tab);
          have.add(tab.key);
        }
      }
      tabsRef.current = next;
      return next;
    });
    const id = await invoke<number>("serial_open", { config });
    if (!liveTabs.current.has(key)) {
      await invoke("serial_close", { id });
      return false;
    }
    commitTabs((current) => current.map((tab) => tab.key === key ? { ...tab, sessionId: id, status: "running", transport: "serial", consoleConfig: config, origin, title: serialTitle(config) } : tab));
    if (exitSplit) applySplit(null);
    return true;
  }
  openSerialRef.current = openSerial;

  const requestClose = (key: string) => {
    const tab = tabsRef.current.find((item) => item.key === key);
    if (!tab || !liveTabs.current.has(key)) return;
    if (!prefsRef.current.confirmCloseBusy || tab.status === "exited" || tab.status === "error" || tab.sessionId == null) {
      closeTab(key);
      return;
    }
    const serial = tab.transport === "serial" || tab.origin?.kind === "serial";
    if (!isTauri() && !serial) {
      closeTab(key);
      return;
    }
    if (serial && (tab.status === "running" || tab.status === "starting")) {
      setCloseAsk({ key, sessionId: tab.sessionId });
      return;
    }
    const sessionId = tab.sessionId;
    void (async () => {
      let info: { ok: true; pid: number | null; foreground_pgid: number | null } | { ok: false };
      try {
        const details = await invoke<SessionDetails>("pty_info", { id: sessionId });
        info = { ok: true, pid: details.pid, foreground_pgid: details.foreground_pgid };
      } catch {
        info = { ok: false };
      }
      if (!liveTabs.current.has(key)) return;
      const latest = tabsRef.current.find((item) => item.key === key);
      if (!latest || latest.sessionId !== sessionId) return;
      const ask = closeNeedsConfirm({
        confirm: prefsRef.current.confirmCloseBusy,
        hasSession: true,
        status: latest.status,
        serial: latest.transport === "serial" || latest.origin?.kind === "serial",
        info,
      });
      if (ask) setCloseAsk({ key, sessionId });
      else closeTab(key);
    })();
  };

  const selectTab = (key: string) => {
    if (splitRef.current) applySplit(selectInSplit(splitRef.current, key));
    const chosen = tabsRef.current.find((item) => item.key === key);
    if (chosen?.attention) {
      commitTabs((current) => {
        const target = current.find((item) => item.key === key);
        if (!target?.attention) return current;
        return current.map((item) => item.key === key ? { ...item, attention: false } : item);
      });
    }
    const already = activeRef.current === key;
    focusKey(key);
    if (already) document.querySelector<HTMLElement>(".term-host.is-active .xterm-helper-textarea")?.focus();
  };

  const cycle = (delta: number) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.key === activeRef.current);
    const next = current[(index + delta + current.length) % current.length];
    if (next) selectTab(next.key);
  };

  const splitToward = async (orientation: "right" | "down") => {
    const sourceKey = activeRef.current;
    const source = tabsRef.current.find((tab) => tab.key === sourceKey);
    if (!source) return;
    const tab = newTab();
    const opened = openSplit(splitRef.current, orientation, sourceKey, tab.key);
    if (opened.error) {
      setStatus(opened.error);
      return;
    }
    applySplit(opened.split);
    insertTab(tab);
    focusKey(tab.key);
    const plan = await planFrom(source);
    if (!liveTabs.current.has(tab.key)) return;
    if (!liveTabs.current.has(sourceKey)) {
      // closeTab already cleared the split. Leave it cleared and still start the new tab.
    }
    void spawnFor(tab.key, plan.cwd ?? undefined, plan.remote ?? undefined, plan.note);
  };

  const focusOtherPane = () => {
    const current = splitRef.current;
    if (!current) { setStatus("No split is open"); return; }
    selectTab(current.keys[current.focus === 0 ? 1 : 0]);
  };

  function openSessionTab(title: string, remote: SpawnRemote) {
    const tab = newTab(title);
    applySplit(null);
    insertTab(tab);
    focusKey(tab.key);
    void spawnFor(tab.key, undefined, remote);
  }

  function saveConnection(candidate: SavedConnection) {
    const error = connectionSaveError(prefsRef.current.connections, candidate);
    if (error) { setStatus(error); return; }
    const clean = cleanConnection(candidate);
    if (!clean) { setStatus("Saved connection is not valid"); return; }
    persistPrefs({ ...prefsRef.current, connections: sanitizeConnections([...prefsRef.current.connections, clean]) });
    setStatus("Saved connection");
  }

  function noteAttention(key: string, reason: "bell" | "finished") {
    if (key === activeRef.current) return;
    if (prefsRef.current.markBackgroundTabs) {
      commitTabs((current) => {
        const tab = current.find((item) => item.key === key);
        if (!tab || tab.attention) return current;
        return current.map((item) => item.key === key ? { ...item, attention: true } : item);
      });
    }
    if (!prefsRef.current.notifySystem) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try { new Notification("AfterTerm", { body: reason === "bell" ? "Bell" : "A command finished" }); } catch { /* the constructor can throw when notifications are unavailable */ }
  }

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
      const clipboard = await readClipboard();
      // Honor maxLength the way typing does: keep only what fits in place of the selection.
      const room = field.maxLength >= 0 ? Math.max(0, field.maxLength - (field.value.length - (end - start))) : Infinity;
      const text = clipboard.slice(0, room);
      // insertText goes through the browser's editing path, so native undo still works.
      // Fall back to setRangeText when the command is unavailable or focus has moved.
      let inserted = false;
      if (document.activeElement === field && typeof document.execCommand === "function") {
        field.setSelectionRange(start, end);
        inserted = text === "" || document.execCommand("insertText", false, text);
      }
      if (!inserted) {
        field.setRangeText(text, start, end, "end");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setStatus(text.length < clipboard.length
        ? `Pasted ${text.length} of ${clipboard.length} characters; this field holds at most ${field.maxLength}`
        : `Pasted ${text.length} characters`);
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

  const openPanel = (panel: "prefs" | "console" | "ssh" | "sah" | "session" | "ssh-connect" | "blocks" | "drive") => {
    setPrefsOpen(panel === "prefs"); setConsoleOpen(panel === "console"); setSshOpen(panel === "ssh");
    setSahOpen(panel === "sah"); setSessionOpen(panel === "session"); setSshConnectOpen(panel === "ssh-connect");
    setBlocksOpen(panel === "blocks"); setDriveOpen(panel === "drive");
  };

  const copyBlockPart = async (part: "command" | "output" | "block") => {
    const text = activePane()?.blockText(part) ?? "";
    if (!text) { setStatus("No block is selected"); return; }
    await writeClipboard(text);
    setStatus(part === "command" ? "Copied command" : part === "output" ? "Copied output" : "Copied block");
  };

  const explainBlock = async () => {
    const text = activePane()?.blockText("block") ?? "";
    if (!text) { setStatus("No block is selected"); return; }
    const result = await explainSelection(text, prefsRef.current.aiEnabled);
    setStatus(result.ok ? result.text : result.reason);
  };

  const flipDisplay = (
    key: "blocksShowExit" | "blocksShowDuration" | "blocksShowTimestamps" | "blocksGutter" | "blocksShellIntegration",
    on: string,
    off: string,
  ) => {
    const next = !prefsRef.current[key];
    persistPrefs({ ...prefsRef.current, [key]: next });
    setStatus(next ? on : off);
  };

  const fontSize = (size: number) => {
    persistPrefs({ ...prefsRef.current, fontSize: Math.min(22, Math.max(10, size)) });
    setStatus(`Font size ${Math.min(22, Math.max(10, size))} points`);
  };

  // Find again uses the text already in the find bar. An empty query only opens the bar.
  const searchAgain = (forward: boolean) => {
    setFindOpen(true);
    const pane = activePane();
    if (findQuery === "" || !pane) {
      setStatus("Nothing to find");
      return;
    }
    if (forward) pane.findNext(findQuery);
    else pane.findPrev(findQuery);
  };

  const runAction = async (action: Action) => {
    const target = editTarget();
    if (target.kind !== "terminal" && (action === "copy" || action === "cut" || action === "paste" || action === "selectAll")) return editField(target, action);
    const pane = activePane();
    switch (action) {
      case "newTab": return addTab();
      case "newWindow": {
        if (!isTauri()) { setStatus("A new window needs the desktop app"); return; }
        await invoke("open_window");
        setStatus("Opened a window");
        return;
      }
      case "closeTab": return requestClose(activeRef.current);
      case "splitRight": return splitToward("right");
      case "splitDown": return splitToward("down");
      case "focusOtherPane": return focusOtherPane();
      case "closeWindow": {
        if (!isTauri()) { setStatus("Closing a window needs the desktop app"); return; }
        await getCurrentWindow().close();
        return;
      }
      case "nextTab": return cycle(1);
      case "prevTab": return cycle(-1);
      case "copy": return copySelection(false);
      case "cut": return copySelection(true);
      case "paste": return pasteClipboard();
      case "selectAll": pane?.selectAll(); setStatus("Selected all terminal text"); return;
      case "clearSelection": pane?.clearSelection(); setStatus("Selection cleared"); return;
      case "find": setFindOpen(true); return;
      case "findNext": return searchAgain(true);
      case "findPrev": return searchAgain(false);
      case "prefs": return prefsOpen ? setPrefsOpen(false) : openPanel("prefs");
      case "clear": pane?.clear(); setStatus("Scrollback cleared"); return;
      case "resetTerminal": return resetTerminal();
      case "fontLarger": return fontSize(prefsRef.current.fontSize + 1);
      case "fontSmaller": return fontSize(prefsRef.current.fontSize - 1);
      case "fontReset": return fontSize(13);
      case "toggleFullscreen": {
        if (!isTauri()) { setStatus("Full screen needs the desktop app"); return; }
        const desktop = getCurrentWindow();
        const next = !(await desktop.isFullscreen());
        await desktop.setFullscreen(next);
        setStatus(next ? "Full screen" : "Left full screen");
        return;
      }
      case "focusTerminal": {
        const focused = activePane();
        if (!focused) { setStatus("No terminal is open"); return; }
        focused.focus();
        setStatus("Terminal focused");
        return;
      }
      case "interrupt": {
        const tab = activeTabNow();
        if (tab?.sessionId != null) await invoke(`${tab.transport ?? "pty"}_write`, { id: tab.sessionId, data: "\u0003" });
        return;
      }
      case "explain": return runExplain();
      case "toggleBlocks": {
        const next = !prefsRef.current.blocksEnabled;
        persistPrefs({ ...prefsRef.current, blocksEnabled: next });
        setStatus(next ? "Blocks on" : "Blocks off");
        return;
      }
      case "openBlocks": return blocksOpen ? setBlocksOpen(false) : openPanel("blocks");
      case "prevBlock": activePane()?.selectBlock(-1); return;
      case "nextBlock": activePane()?.selectBlock(1); return;
      case "copyBlock": return copyBlockPart("block");
      case "explainBlock": return explainBlock();
      case "openDrive": return driveOpen ? setDriveOpen(false) : openPanel("drive");
      case "saveTranscript": return saveText("transcript");
      case "saveSelection": return saveText("selection");
      case "exportHtml": return saveText("html");
      case "print": return printTranscript();
      case "logSession": return toggleLog();
      case "sessionInfo": return openPanel("session");
      case "toggleReview": return toggleReview();
      case "connectSsh": return openPanel("ssh-connect");
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
    if (id === "shell.stty-show") { void sendCommand("stty -a", "Sent stty -a; the settings are in the terminal output").catch((error) => setStatus(String(error))); return; }
    if (id === "view.prefs" || id === "ai.settings") { openPanel("prefs"); return; }
    if (id === "view.copy-on-select") {
      const next = !prefsRef.current.copyOnSelect;
      persistPrefs({ ...prefsRef.current, copyOnSelect: next });
      setStatus(next ? "Copy on select on" : "Copy on select off");
      return;
    }
    if (id === "view.reduce-motion") {
      const next = !prefsRef.current.reducedMotion;
      persistPrefs({ ...prefsRef.current, reducedMotion: next });
      setStatus(next ? "Reduce motion on" : "Reduce motion off");
      return;
    }
    if (id === "ai.explain-block") { perform("explainBlock"); return; }
    if (id === "blocks.copy-command") { void copyBlockPart("command").catch((error) => setStatus(String(error))); return; }
    if (id === "blocks.copy-output") { void copyBlockPart("output").catch((error) => setStatus(String(error))); return; }
    if (id === "blocks.snippet") {
      void writeClipboard(INTEGRATION_SNIPPET).then(() => setStatus("Copied shell integration snippet")).catch((error) => setStatus(String(error)));
      return;
    }
    if (id === "blocks.show-exit") { flipDisplay("blocksShowExit", "Exit codes shown", "Exit codes hidden"); return; }
    if (id === "blocks.show-duration") { flipDisplay("blocksShowDuration", "Durations shown", "Durations hidden"); return; }
    if (id === "blocks.show-timestamps") { flipDisplay("blocksShowTimestamps", "Timestamps shown", "Timestamps hidden"); return; }
    if (id === "blocks.gutter") { flipDisplay("blocksGutter", "Block gutter on", "Block gutter off"); return; }
    if (id === "blocks.shell-integration") { flipDisplay("blocksShellIntegration", "Shell integration on for new local tabs", "Shell integration off"); return; }
  };
  handleMenuRef.current = handleMenu;

  useEffect(() => {
    // Any new key press or click ends the window in which a duplicate menu event is ignored.
    const clearHandled = () => { keyHandled.current = null; };
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest(".prefs, .blocks, .drive, [role=dialog], .findbar, .console-panel, .ssh-panel")) return;
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
        onSelect={selectTab}
        onClose={requestClose}
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
      <main className={`stage${split ? ` is-split-${split.orientation}` : ""}`}>
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
              panelId={panelId(tab.key)}
              tabId={tabId(tab.key)}
              transport={tab.transport}
              consoleConfig={tab.consoleConfig}
              onPaste={(text) => { if (tab.consoleConfig && tab.sessionId != null) setPaste({ id: tab.sessionId, text, config: tab.consoleConfig }); }}
              onChallenge={(id, next) => enqueueRef.current({ id, challenge: next, transport: tab.transport ?? "pty" })}
              onAttached={(snapshot) => {
                const nextStatus = snapshot.exit != null ? "exited" : "running";
                commitTabs((current) => {
                  const item = current.find((entry) => entry.key === tab.key && entry.sessionId === tab.sessionId);
                  if (!item || (item.reviewed === snapshot.reviewed && item.status === nextStatus)) return current;
                  return current.map((entry) => entry.key === tab.key && entry.sessionId === tab.sessionId ? { ...entry, reviewed: snapshot.reviewed, status: nextStatus } : entry);
                });
              }}
              active={tab.key === activeKey}
              shown={split ? split.keys.includes(tab.key) : tab.key === activeKey}
              local={tab.origin?.kind === "local" || tab.origin == null}
              hostnames={hostnames}
              onAttention={() => noteAttention(tab.key, "bell")}
              onCwd={(path) => {
                commitTabs((current) => {
                  const item = current.find((entry) => entry.key === tab.key);
                  if (!item || item.reportedCwd === path) return current;
                  return current.map((entry) => entry.key === tab.key ? { ...entry, reportedCwd: path } : entry);
                });
              }}
              prefs={prefs}
              onTitle={(title) => {
                if (tab.transport === "serial") return;
                commitTabs((current) => {
                  const item = current.find((entry) => entry.key === tab.key);
                  if (!item || item.title === title) return current;
                  return current.map((entry) => entry.key === tab.key ? { ...entry, title } : entry);
                });
                if (tab.sessionId != null) void invoke("pty_set_title", { id: tab.sessionId, title }).catch(() => undefined);
              }}
              onStatus={setStatus}
              onBlocks={(sessionId, records, selectedId) => {
                setBlocksBySession((current) => ({ ...current, [sessionId]: { blocks: records, selectedId } }));
                const finished = records.filter((record) => record.status === "finished").length;
                const previous = finishedCounts.current.has(sessionId) ? finishedCounts.current.get(sessionId) ?? null : null;
                finishedCounts.current.set(sessionId, finished);
                if (previous != null && finished > previous) noteAttention(tab.key, "finished");
              }}
            />
          ),
        )}
      </main>
      <footer className="status">
        <button onClick={() => openPanel("console")}>Connect console</button>
        <button onClick={() => (sshConnectOpen ? setSshConnectOpen(false) : openPanel("ssh-connect"))}>Connect SSH</button>
        <button onClick={() => (sahOpen ? setSahOpen(false) : openPanel("sah"))}>Connect SAH</button>
        <button onClick={() => (blocksOpen ? setBlocksOpen(false) : openPanel("blocks"))}>Blocks</button>
        <button onClick={() => (driveOpen ? setDriveOpen(false) : openPanel("drive"))}>Drive</button>
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
      {sshConnectOpen && <ConnectSshPanel user={sshUser} host={sshHost} port={sshPortText} onUser={setSshUser} onHost={setSshHost} onPort={setSshPortText} onClose={() => setSshConnectOpen(false)}
        connections={prefs.connections.filter((item) => item.kind === "ssh")} connectionCount={prefs.connections.length} onSave={saveConnection}
        onLaunch={(title, target) => { openSessionTab(title, { kind: "ssh", target, title }); setSshConnectOpen(false); }} />}
      {sahOpen && <SahPanel host={sahHost} onHost={setSahHost} onClose={() => setSahOpen(false)} onLaunch={(title, args) => { openSessionTab(title, { kind: "sah", args }); setSahOpen(false); }} />}
      {consoleOpen && <ConsolePanel onConnect={connectConsole} onClose={() => setConsoleOpen(false)}
        connections={prefs.connections.filter((item) => item.kind === "serial")} connectionCount={prefs.connections.length} onSave={saveConnection} />}
      {prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={persistPrefs} onClose={() => setPrefsOpen(false)} onStatus={setStatus} />
      )}
      {blocksOpen && (
        <BlocksPanel
          prefs={prefs}
          blocks={activeTab?.sessionId != null ? blocksBySession[activeTab.sessionId]?.blocks ?? [] : []}
          selectedId={activeTab?.sessionId != null ? blocksBySession[activeTab.sessionId]?.selectedId ?? null : null}
          onSelect={(id) => activePane()?.selectBlockId(id)}
          onClose={() => setBlocksOpen(false)}
        />
      )}
      {driveOpen && (
        <DrivePanel prefs={prefs} onCommit={persistPrefs} onClose={() => setDriveOpen(false)} onStatus={setStatus} />
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
      {closeAsk && (
        <div className="confirm-scrim" role="dialog" aria-modal="true" aria-labelledby="close-tab-title">
          <div className="confirm-card">
            <h2 id="close-tab-title">Close this tab?</h2>
            <p>A program is still running in this tab, or its state could not be read. Closing the tab stops it.</p>
            <div className="confirm-actions">
              <button type="button" autoFocus onClick={() => setCloseAsk(null)}>Cancel</button>
              <button type="button" className="danger" onClick={() => {
                const ask = closeAsk;
                setCloseAsk(null);
                const latest = tabsRef.current.find((tab) => tab.key === ask.key);
                if (latest && latest.sessionId === ask.sessionId) closeTab(ask.key);
              }}>Close tab</button>
            </div>
          </div>
        </div>
      )}
      <pre className="print-view" aria-hidden="true">{printText}</pre>
    </div>
  );
}

function ConnectSshPanel({ user, host, port, onUser, onHost, onPort, onClose, onLaunch, connections, connectionCount, onSave }: {
  user: string; host: string; port: string;
  onUser: (user: string) => void; onHost: (host: string) => void; onPort: (port: string) => void;
  onClose: () => void; onLaunch: (title: string, target: SshTarget) => void;
  connections: readonly Extract<SavedConnection, { kind: "ssh" }>[];
  connectionCount: number;
  onSave: (candidate: SavedConnection) => void;
}) {
  const panelRef = usePanel<HTMLElement>(onClose);
  const [name, setName] = useState("");
  const trimmedPort = port.trim();
  const parsedPort = trimmedPort === "" ? null : sshPort(trimmedPort);
  const destination = trimmedPort === "" || parsedPort != null ? sshDestination({ host, user, port: parsedPort }) : null;
  const previewPort = trimmedPort === "" ? null : parsedPort ?? Number.NaN;
  const preview = cleanConnection({ id: PREVIEW_CONNECTION_ID, name: name.trim(), kind: "ssh", host: host.trim(), user: user.trim(), port: previewPort });
  const canSave = preview != null && connectionCount < 32;
  const launch = () => {
    if (!destination || (trimmedPort !== "" && parsedPort == null)) return;
    onLaunch(`ssh ${destination}`, { host: host.trim(), user: user.trim() || null, port: parsedPort });
  };
  const save = () => {
    if (!preview || preview.kind !== "ssh") return;
    const clean = cleanConnection({ ...preview, id: crypto.randomUUID() });
    if (clean) onSave(clean);
  };
  return <aside ref={panelRef} className="prefs" role="dialog" aria-labelledby="ssh-connect-title">
    <header><h2 id="ssh-connect-title" tabIndex={-1}>Connect SSH</h2><button onClick={onClose}>Close</button></header>
    <p className="prefs-note">Starts a new tab with the installed OpenSSH client. Host-key checking stays that client's default. AfterTerm does not store credentials and does not verify the remote target identity. Input starts in direct mode unless new tabs start reviewed in Preferences.</p>
    <label>SSH user<input value={user} onChange={(event) => onUser(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onKeyDown={(event) => { if (event.key === "Enter") launch(); }} /></label>
    <label>SSH host<input data-autofocus value={host} onChange={(event) => onHost(event.target.value)} placeholder="web1 or [2001:db8::1]" autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onKeyDown={(event) => { if (event.key === "Enter") launch(); }} /></label>
    <label>SSH port<input value={port} onChange={(event) => onPort(event.target.value)} inputMode="numeric" placeholder="22"
      onKeyDown={(event) => { if (event.key === "Enter") launch(); }} /></label>
    <button disabled={destination == null} onClick={launch}>Connect</button>
    <label>Connection name<input value={name} onChange={(event) => setName(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /></label>
    <button type="button" disabled={!canSave} onClick={save}>Save connection</button>
    {connections.map((connection) => {
      const label = sshDestination({ host: connection.host, user: connection.user, port: connection.port });
      if (!label) return null;
      return <button type="button" key={connection.id} onClick={() => onLaunch(`ssh ${label}`, { host: connection.host, user: connection.user, port: connection.port })}>Connect {connection.name}</button>;
    })}
  </aside>;
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
