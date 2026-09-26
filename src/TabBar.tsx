import type { ConsoleConfig } from "./console.ts";
export type Tab = {
  consoleConfig?: ConsoleConfig;
  transport?: "pty" | "serial";
  key: string;
  sessionId: number | null;
  title: string;
  status: "starting" | "running" | "exited" | "error";
};

type Props = {
  tabs: Tab[];
  activeKey: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
};

export function TabBar({ tabs, activeKey, onSelect, onClose, onNew }: Props) {
  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="tabbar-traffic" data-tauri-drag-region />
      <div className="tabs" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={tab.key === activeKey}
            className={`tab ${tab.key === activeKey ? "is-active" : ""} ${tab.status === "exited" ? "is-exited" : ""}`}
            onClick={() => onSelect(tab.key)}
            title={tab.title}
          >
            <span className="tab-title">{tab.title}</span>
            <span
              className="tab-close"
              role="button"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.key);
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>
      <button className="tab-new" onClick={onNew} aria-label="New tab">
        +
      </button>
    </div>
  );
}
