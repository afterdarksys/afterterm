import { THEME_IDS, resolveTheme } from "./themes.ts";
import type { Prefs } from "./prefs.ts";

const FONTS = [
  "SF Mono, Menlo, ui-monospace, monospace",
  "Menlo, Monaco, Courier New, monospace",
  "JetBrains Mono, SF Mono, monospace",
  "IBM Plex Mono, SF Mono, monospace",
  "ui-monospace, SFMono-Regular, Menlo, monospace",
];

type Props = {
  prefs: Prefs;
  onChange: (prefs: Prefs) => void;
  onClose: () => void;
};

export function PrefsPanel({ prefs, onChange, onClose }: Props) {
  return (
    <aside className="prefs" aria-label="Preferences">
      <header>
        <h2>Preferences</h2>
        <button type="button" onClick={onClose} aria-label="Close preferences">
          ×
        </button>
      </header>
      <label>
        Theme
        <select
          value={prefs.theme}
          onChange={(event) => onChange({ ...prefs, theme: event.target.value })}
        >
          {THEME_IDS.map((id) => (
            <option key={id} value={id}>
              {resolveTheme(id).label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Font
        <select
          value={prefs.fontFamily}
          onChange={(event) => onChange({ ...prefs, fontFamily: event.target.value })}
        >
          {FONTS.map((font) => (
            <option key={font} value={font}>
              {font.split(",")[0]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Size {prefs.fontSize}px
        <input
          type="range"
          min={10}
          max={22}
          value={prefs.fontSize}
          onChange={(event) => onChange({ ...prefs, fontSize: Number(event.target.value) })}
        />
      </label>
      <label>
        Glass {Math.round(prefs.transparency * 100)}%
        <input
          type="range"
          min={40}
          max={100}
          value={Math.round(prefs.transparency * 100)}
          onChange={(event) => onChange({ ...prefs, transparency: Number(event.target.value) / 100 })}
        />
      </label>
      <label>
        Cursor
        <select
          value={prefs.cursorStyle}
          onChange={(event) => onChange({ ...prefs, cursorStyle: event.target.value as Prefs["cursorStyle"] })}
        >
          <option value="bar">Bar</option>
          <option value="block">Block</option>
          <option value="underline">Underline</option>
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={prefs.aiEnabled}
          onChange={(event) => onChange({ ...prefs, aiEnabled: event.target.checked })}
        />
        Enable AI layer (optional)
      </label>
      <p className="prefs-note">
        AI stays off the critical path. Shells, tabs, colors, and keybindings work with this unchecked.
      </p>
    </aside>
  );
}
