import { OutputReplay, type Snapshot } from "./outputReplay.ts";
import { consoleInput, type ConsoleConfig } from "./console.ts";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { Challenge } from "./ConfirmDialog.tsx";
import type { Prefs } from "./prefs.ts";
import { resolveTheme, withAlpha } from "./themes.ts";

const MAX_LAYOUT_FRAMES = 60;

function decodeChunk(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type TerminalPaneHandle = {
  focus: () => void;
  fit: () => void;
  clear: () => void;
  copySelection: () => string;
  paste: (text: string) => void;
  findNext: (query: string) => void;
  findPrev: (query: string) => void;
  getSelection: () => string;
};

type Props = {
  sessionId: number;
  consoleConfig?: ConsoleConfig;
  transport?: "pty" | "serial";
  onPaste: (text: string) => void;
  onAttached: (snapshot: Snapshot) => void;
  onChallenge: (id: number, challenge: Challenge) => void;
  active: boolean;
  prefs: Prefs;
  onTitle: (title: string) => void;
  onStatus: (message: string) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  { sessionId, consoleConfig, transport = "pty", onPaste, onChallenge, onAttached, active, prefs, onTitle, onStatus },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const pasteRef = useRef(onPaste);
  pasteRef.current = onPaste;
  const challengeRef = useRef(onChallenge);
  challengeRef.current = onChallenge;
  const resize = (rows: number, cols: number) => transport === "serial" ? Promise.resolve() : invoke("pty_resize", { id: sessionRef.current, rows, cols });
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const attachedRef = useRef(onAttached); attachedRef.current = onAttached;
  const write = (data: string) => {
    writeQueue.current = writeQueue.current.then(async () => {
    try {
      if (consoleConfig) data = consoleInput(data, consoleConfig);
      const challenge = await invoke<Challenge | null>(`${transport}_write`, { id: sessionRef.current, data });
      if (!challenge && consoleConfig?.localEcho) termRef.current?.write(data);
      if (challenge) challengeRef.current(sessionRef.current, challenge);
    } catch (error) { onStatusRef.current(`Write failed: ${String(error)}`); }
    });
    return writeQueue.current;
  };

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    fit: () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        void resize(term.rows, term.cols).catch(() => undefined);
      } catch {
        /* layout not ready */
      }
    },
    clear: () => termRef.current?.clear(),
    copySelection: () => termRef.current?.getSelection() ?? "",
    paste: (text: string) => {
      if (!termRef.current) return;
      if (transport === "serial") pasteRef.current(text); else termRef.current.paste(text);
    },
    findNext: (query: string) => {
      searchRef.current?.findNext(query);
    },
    findPrev: (query: string) => {
      searchRef.current?.findPrevious(query);
    },
    getSelection: () => termRef.current?.getSelection() ?? "",
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const theme = withAlpha(resolveTheme(prefsRef.current.theme, prefsRef.current.themeOverrides[prefsRef.current.theme]).terminal, prefsRef.current.transparency);
    const term = new Terminal({
      fontFamily: prefsRef.current.fontFamily,
      fontSize: prefsRef.current.fontSize,
      cursorBlink: !prefsRef.current.reducedMotion,
      cursorStyle: prefsRef.current.cursorStyle,
      scrollback: prefsRef.current.scrollback,
      allowProposedApi: true,
      theme,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    let disposed = false;
    let listeners: UnlistenFn[] = [];
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let webgl: WebglAddon | undefined;

    const canFit = () =>
      !disposed && !!term.element?.isConnected && host.clientWidth > 0 && host.clientHeight > 0;

    const refit = () => {
      if (!canFit()) return false;
      try {
        fit.fit();
        return true;
      } catch {
        return false;
      }
    };

    const scheduleRefit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!refit()) return;
        void resize(term.rows, term.cols).catch(() => {
          /* session may still be starting */
        });
      });
    };

    let attached = false;
    let exitCode: number | null = null;
    let exitShown = false;
    const replay = new OutputReplay((data) => term.write(data), (message) => term.writeln(`\r\n[${message}]`));
    const showExit = () => {
      if (!attached || exitCode == null || exitShown || disposed) return;
      exitShown = true;
      const message = transport === "serial" ? "Console disconnected" : `Shell exited with code ${exitCode}`;
      onStatusRef.current(message); term.writeln(`\r\n[${message}]`);
    };
    const addListener = async <T,>(event: string, handler: (payload: T) => void) => {
      const off = await listen<T>(event, (event) => { if (!disposed) handler(event.payload); });
      if (disposed) off(); else listeners.push(off);
    };
    const connect = async () => {
      try {
        await addListener<{ id: number; data: string; sequence: number }>(`${transport}:output`, (payload) => {
          if (payload.id !== sessionId) return;
          const data = decodeChunk(payload.data);
          if (transport === "pty") replay.receive({ sequence: payload.sequence, data }); else term.write(data);
        });
        if (disposed) return;
        await addListener<{ id: number; code: number }>(`${transport}:exit`, (payload) => {
          if (payload.id !== sessionId) return;
          exitCode = payload.code; showExit();
        });
        if (disposed) return;
        if (transport === "serial") await invoke("serial_attach", { id: sessionId });
        else {
          const snapshot = await invoke<Snapshot>("pty_attach", { id: sessionId });
          if (disposed) return;
          replay.attach(snapshot);
          exitCode = snapshot.exit ?? exitCode;
          attachedRef.current({ ...snapshot, exit: exitCode });
          if (snapshot.pending) challengeRef.current(sessionId, snapshot.pending);
        }
        attached = true; showExit();
      } catch (error) {
        listeners.forEach((off) => off()); listeners = [];
        if (!disposed) onStatusRef.current(`Could not attach terminal: ${String(error)}`);
      }
    };

    let attempts = 0;
    const startWhenLaidOut = () => {
      if (disposed) return;
      if (!term.element) {
        term.open(host);
        try {
          webgl = new WebglAddon();
          term.loadAddon(webgl);
        } catch {
          webgl = undefined;
        }
        frame = requestAnimationFrame(startWhenLaidOut);
        return;
      }
      if (!refit() && attempts < MAX_LAYOUT_FRAMES) {
        attempts += 1;
        frame = requestAnimationFrame(startWhenLaidOut);
        return;
      }
      observer = new ResizeObserver(scheduleRefit);
      observer.observe(host);
      void connect();
      void resize(term.rows, term.cols).catch(() => {
        /* first fit */
      });
    };
    frame = requestAnimationFrame(startWhenLaidOut);

    const input = term.onData((data) => {
      void write(data);
    });
    const title = term.onTitleChange((value) => onTitleRef.current(value || "shell"));

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      input.dispose();
      title.dispose();
      listeners.forEach((unlisten) => unlisten());
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const id = requestAnimationFrame(() => {
      term.options.theme = withAlpha(resolveTheme(prefs.theme, prefs.themeOverrides[prefs.theme]).terminal, prefs.transparency);
      term.options.fontFamily = prefs.fontFamily;
      term.options.fontSize = prefs.fontSize;
      term.options.cursorStyle = prefs.cursorStyle;
      term.options.cursorBlink = !prefs.reducedMotion;
      term.options.scrollback = prefs.scrollback;
    });
    return () => cancelAnimationFrame(id);
  }, [prefs]);

  useEffect(() => {
    if (!active) return;
    termRef.current?.focus();
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        void resize(term.rows, term.cols).catch(() => undefined);
      } catch {
        /* layout */
      }
    });
  }, [active]);

  return <div className={`term-host ${active ? "is-active" : "is-inactive"}`} ref={hostRef} onPasteCapture={(event) => {
    if (transport !== "serial") return;
    event.preventDefault(); event.stopPropagation(); pasteRef.current(event.clipboardData.getData("text/plain"));
  }} />;
});
