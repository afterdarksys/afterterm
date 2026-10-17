import type { KeyboardEvent } from "react";
import type { ConsoleConfig } from "./console.ts";
export type Tab = {
  reviewed?: boolean;
  consoleConfig?: ConsoleConfig;
  transport?: "pty" | "serial";
  key: string;
  sessionId: number | null;
  title: string;
  status: "starting" | "running" | "exited" | "error";
};

/** Element ids that tie each tab to its terminal panel (aria-controls / aria-labelledby). */
export const tabId = (key: string) => `${key}-tab`;
export const panelId = (key: string) => `${key}-panel`;

type Props = {
  tabs: Tab[];
  activeKey: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
};

const STATUS_TEXT: Partial<Record<Tab["status"], string>> = { starting: "starting", exited: "exited", error: "failed to start" };

/**
 * Tabs follow the WAI-ARIA tabs pattern with manual activation: Left and Right arrows (and Home,
 * End) move focus between tabs, Enter or Space opens the focused tab and moves focus to its
 * terminal, and Delete or Backspace closes the focused tab. Only the selected tab is in the Tab
 * order; its Close button follows it.
 */
export function TabBar({ tabs, activeKey, onSelect, onClose, onNew }: Props) {
  const focusTab = (key: string | undefined) => {
    if (key) document.getElementById(tabId(key))?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const last = tabs.length - 1;
    const move: Record<string, number> = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last };
    if (event.key in move) {
      event.preventDefault();
      focusTab(tabs[move[event.key]]?.key);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const tab = tabs[index];
      // Closing the selected tab moves focus to the next selected tab's terminal (as Close Tab
      // does); closing another tab keeps focus in the tab list, on its neighbour.
      const neighbour = tabs[index + 1] ?? tabs[index - 1];
      onClose(tab.key);
      if (tab.key !== activeKey) requestAnimationFrame(() => focusTab(neighbour?.key));
    }
  };

  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="tabbar-traffic" data-tauri-drag-region />
      <div className="tabs" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab, index) => {
          const selected = tab.key === activeKey;
          const state = STATUS_TEXT[tab.status];
          return (
            <div key={tab.key} role="presentation" className={`tab ${selected ? "is-active" : ""} ${tab.status === "exited" ? "is-exited" : ""}`}>
              <button
                id={tabId(tab.key)}
                role="tab"
                className="tab-select"
                aria-selected={selected}
                aria-controls={tab.sessionId != null ? panelId(tab.key) : undefined}
                aria-keyshortcuts="Delete Backspace"
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(tab.key)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                title={tab.title}
              >
                <span className="tab-title">{tab.title}</span>
                {state && <span className="visually-hidden">, {state}</span>}
              </button>
              <button
                className="tab-close"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onClose(tab.key)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          );
        })}
      </div>
      <button className="tab-new" onClick={onNew} aria-label="New tab">
        +
      </button>
    </div>
  );
}
