import { useState } from "react";
import { CHROME_COLORS, TERMINAL_COLORS, validColor, cleanOverrides, THEME_IDS, resolveTheme, type ThemeOverrides } from "./themes.ts";
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
  const [paletteText, setPaletteText] = useState("");
  const [paletteError, setPaletteError] = useState("");
  const theme = resolveTheme(prefs.theme, prefs.themeOverrides[prefs.theme]);
  const updatePalette = (overrides: ThemeOverrides) => onChange({
    ...prefs, themeOverrides: { ...prefs.themeOverrides, [prefs.theme]: overrides },
  });
  const setColor = (group: "terminal" | "chrome", key: string, value: string) => {
    const overrides = prefs.themeOverrides[prefs.theme] ?? {};
    const colors: Record<string, string> = { ...overrides[group], [key]: value };
    if (!value) delete colors[key];
    updatePalette({ ...overrides, [group]: colors });
  };
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
      <details className="palette-editor">
        <summary>Customize palette</summary>
        <p className="prefs-note">Changes apply live and are saved per theme. Use hex or rgba colors.</p>
        {([ ["terminal", TERMINAL_COLORS], ["chrome", CHROME_COLORS] ] as const).map(([group, keys]) => (
          <fieldset key={`${prefs.theme}-${group}`}>
            <legend>{group === "terminal" ? "Terminal colors" : "Application colors"}</legend>
            {keys.map((key) => {
              const value = (theme[group] as Record<string, string>)[key] ?? "";
              return <ColorField key={`${key}-${value}`} name={key} value={value}
                onChange={(color) => setColor(group, key, color)} />;
            })}
          </fieldset>
        ))}
        <button type="button" onClick={() => updatePalette({})}>Reset this palette</button>
        <label>Palette JSON
          <textarea rows={5} value={paletteText} onChange={(event) => setPaletteText(event.target.value)}
            placeholder="Export a palette, or paste one to import" />
        </label>
        <div className="palette-actions">
          <button type="button" onClick={() => {
            setPaletteText(JSON.stringify({ terminal: theme.terminal, chrome: theme.chrome }, null, 2));
            setPaletteError("");
          }}>Export</button>
          <button type="button" onClick={() => {
            try {
              const parsed = JSON.parse(paletteText);
              const clean = cleanOverrides(parsed);
              if (!Object.keys(clean).length) throw new Error("No supported colors found.");
              for (const group of ["terminal", "chrome"] as const) {
                for (const [key, color] of Object.entries(parsed[group] ?? {})) {
                  if (!validColor(color) || !Object.prototype.hasOwnProperty.call(clean[group] ?? {}, key))
                    throw new Error(`Unsupported color: ${group}.${key}`);
                }
              }
              updatePalette(clean);
              setPaletteError("");
            } catch (error) { setPaletteError(error instanceof Error ? error.message : "Invalid palette JSON."); }
          }}>Import</button>
        </div>
        {paletteError && <p role="alert">{paletteError}</p>}
      </details>
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
      <label>
        Scrollback lines
        <input type="number" min={0} max={100000} step={1000} value={prefs.scrollback}
          onChange={(event) => onChange({ ...prefs, scrollback: Math.min(100000, Math.max(0, Math.trunc(Number(event.target.value)))) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.reducedMotion}
          onChange={(event) => onChange({ ...prefs, reducedMotion: event.target.checked })} />
        Reduce motion / disable cursor blinking
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

function ColorField({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const invalid = draft !== "" && !validColor(draft);
  return <label className="color-field">
    <span><i aria-hidden="true" style={{ background: value || "transparent" }} />{name}</span>
    <input value={draft} aria-invalid={invalid} spellCheck={false} placeholder="Inherited"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (!invalid && draft !== value) onChange(draft); }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    {invalid && <small>Use #rrggbb, #rrggbbaa, or rgba(r, g, b, a).</small>}
  </label>;
}
