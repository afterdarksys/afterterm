import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
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
  active: boolean;
  prefs: Prefs;
  onTitle: (title: string) => void;
  onStatus: (message: string) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  { sessionId, active, prefs, onTitle, onStatus },
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

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    fit: () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        void invoke("pty_resize", { id: sessionRef.current, rows: term.rows, cols: term.cols });
      } catch {
        /* layout not ready */
      }
    },
    clear: () => termRef.current?.clear(),
    copySelection: () => termRef.current?.getSelection() ?? "",
    paste: (text: string) => {
      void invoke("pty_write", { id: sessionRef.current, data: text });
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

    const theme = withAlpha(resolveTheme(prefsRef.current.theme).terminal, prefsRef.current.transparency);
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
        void invoke("pty_resize", { id: sessionRef.current, rows: term.rows, cols: term.cols }).catch(() => {
          /* session may still be starting */
        });
      });
    };

    const connect = async () => {
      try {
        const [onOutput, onExit] = await Promise.all([
          listen<{ id: number; data: string }>("pty:output", (event) => {
            if (event.payload.id !== sessionRef.current) return;
            term.write(decodeChunk(event.payload.data));
          }),
          listen<{ id: number; code: number }>("pty:exit", (event) => {
            if (event.payload.id !== sessionRef.current) return;
            onStatusRef.current(`Shell exited with code ${event.payload.code}`);
            term.writeln(`\r\n\x1b[90m[shell exited with code ${event.payload.code}]\x1b[0m`);
          }),
        ]);
        if (disposed) {
          onOutput();
          onExit();
          return;
        }
        listeners = [onOutput, onExit];
      } catch (error) {
        if (!disposed) {
          onStatusRef.current(`Could not attach shell: ${String(error)}`);
        }
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
      void invoke("pty_resize", { id: sessionRef.current, rows: term.rows, cols: term.cols }).catch(() => {
        /* first fit */
      });
    };
    frame = requestAnimationFrame(startWhenLaidOut);

    const input = term.onData((data) => {
      void invoke("pty_write", { id: sessionRef.current, data }).catch((error) => {
        term.writeln(`\r\n\x1b[31m[write failed: ${String(error)}]\x1b[0m`);
      });
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
      term.options.theme = withAlpha(resolveTheme(prefs.theme).terminal, prefs.transparency);
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
        void invoke("pty_resize", { id: sessionRef.current, rows: term.rows, cols: term.cols });
      } catch {
        /* layout */
      }
    });
  }, [active]);

  return <div className={`term-host ${active ? "is-active" : "is-inactive"}`} ref={hostRef} />;
});
