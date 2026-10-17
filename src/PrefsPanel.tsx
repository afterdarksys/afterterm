import { useId, useState } from "react";
import {
  CHROME_COLORS, TERMINAL_COLORS, NAMED_COLORS, validColor, cleanOverrides, THEME_IDS, resolveTheme,
  parseColorInput, describeColor, colorLabel, type ThemeOverrides,
} from "./themes.ts";
import { DEFAULT_PREFS, LINE_HEIGHTS, type Prefs } from "./prefs.ts";
import { usePanel } from "./usePanel.ts";

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
  onStatus: (message: string) => void;
};

export function PrefsPanel({ prefs, onChange, onClose, onStatus }: Props) {
  const [paletteText, setPaletteText] = useState("");
  const [paletteError, setPaletteError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const panelRef = usePanel<HTMLElement>(onClose);
  const theme = resolveTheme(prefs.theme, prefs.themeOverrides[prefs.theme]);
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K], announce?: string) => {
    onChange({ ...prefs, [key]: value });
    if (announce) onStatus(announce);
  };
  const updatePalette = (overrides: ThemeOverrides) => onChange({
    ...prefs, themeOverrides: { ...prefs.themeOverrides, [prefs.theme]: overrides },
  });
  const setColor = (group: "terminal" | "chrome", key: string, value: string) => {
    const overrides = prefs.themeOverrides[prefs.theme] ?? {};
    const colors: Record<string, string> = { ...overrides[group], [key]: value };
    if (!value) delete colors[key];
    updatePalette({ ...overrides, [group]: colors });
    onStatus(value ? `${colorLabel(key)} set to ${value}, ${describeColor(value)}` : `${colorLabel(key)} reset to the theme color`);
  };
  return (
    <aside ref={panelRef} className="prefs" role="dialog" aria-labelledby="prefs-title">
      <header>
        <h2 id="prefs-title" tabIndex={-1}>Preferences</h2>
        <button type="button" onClick={onClose}>Close</button>
      </header>
      <p className="prefs-note">Changes apply immediately and are saved. Press Escape to close.</p>

      <section aria-labelledby="prefs-theme">
        <h3 id="prefs-theme">Theme and colors</h3>
        <label>
          Theme
          <select data-autofocus value={prefs.theme}
            onChange={(event) => set("theme", event.target.value, `Theme ${resolveTheme(event.target.value).label} applied`)}>
            {THEME_IDS.map((id) => <option key={id} value={id}>{resolveTheme(id).label}</option>)}
          </select>
        </label>
        <details className="palette-editor">
          <summary>Customize colors for the {theme.label} theme</summary>
          <p className="prefs-note" id="color-help">
            Type a color name such as red, navy or amber, or a hex value such as #e8b86d, or rgba(r, g, b, a). Press Enter or leave the field to apply. Clear a field to use the theme color.
          </p>
          <datalist id="named-colors">{Object.keys(NAMED_COLORS).map((color) => <option key={color} value={color} />)}</datalist>
          {([["terminal", TERMINAL_COLORS], ["chrome", CHROME_COLORS]] as const).map(([group, keys]) => (
            <fieldset key={`${prefs.theme}-${group}`}>
              <legend>{group === "terminal" ? "Terminal colors" : "Application colors"}</legend>
              {keys.map((key) => {
                const value = (theme[group] as Record<string, string>)[key] ?? "";
                return <ColorField key={`${key}-${value}`} name={key} value={value}
                  onChange={(color) => setColor(group, key, color)} />;
              })}
            </fieldset>
          ))}
          <button type="button" onClick={() => { updatePalette({}); onStatus(`${theme.label} colors reset`); }}>Reset colors for this theme</button>
          <label>Palette JSON
            <textarea rows={5} value={paletteText} onChange={(event) => setPaletteText(event.target.value)}
              placeholder="Export a palette, or paste one to import" />
          </label>
          <div className="palette-actions">
            <button type="button" onClick={() => {
              setPaletteText(JSON.stringify({ terminal: theme.terminal, chrome: theme.chrome }, null, 2));
              setPaletteError("");
              onStatus("Palette exported to the Palette JSON field");
            }}>Export palette</button>
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
                onStatus("Palette imported");
              } catch (error) { setPaletteError(error instanceof Error ? error.message : "Invalid palette JSON."); }
            }}>Import palette</button>
          </div>
          {paletteError && <p role="alert">{paletteError}</p>}
        </details>
        <label>
          Window transparency
          <select value={Math.round(prefs.transparency * 100)}
            onChange={(event) => set("transparency", Number(event.target.value) / 100, `Transparency ${event.target.value} percent opaque`)}>
            {[...new Set([40, 50, 60, 70, 82, 90, 100, Math.round(prefs.transparency * 100)])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value}% opaque{value === 100 ? " (solid)" : ""}</option>)}
          </select>
        </label>
      </section>

      <section aria-labelledby="prefs-text">
        <h3 id="prefs-text">Text</h3>
        <label>
          Font
          <select value={prefs.fontFamily} onChange={(event) => set("fontFamily", event.target.value)}>
            {FONTS.map((font) => <option key={font} value={font}>{font.split(",")[0]}</option>)}
          </select>
        </label>
        <label>
          Font size in points
          <input type="number" min={10} max={22} step={1} value={prefs.fontSize}
            onChange={(event) => {
              const size = Math.trunc(Number(event.target.value));
              if (size >= 10 && size <= 22) set("fontSize", size);
            }} />
        </label>
        <label>
          Line height
          <select value={prefs.lineHeight} onChange={(event) => set("lineHeight", Number(event.target.value))}>
            {LINE_HEIGHTS.map((value) => <option key={value} value={value}>{value === 1 ? "1 (default)" : value}</option>)}
          </select>
        </label>
      </section>

      <section aria-labelledby="prefs-cursor">
        <h3 id="prefs-cursor">Cursor and bell</h3>
        <label>
          Cursor shape
          <select value={prefs.cursorStyle} onChange={(event) => set("cursorStyle", event.target.value as Prefs["cursorStyle"])}>
            <option value="bar">Bar</option>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.cursorBlink} onChange={(event) => set("cursorBlink", event.target.checked)} />
          Blink the cursor
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.reducedMotion} onChange={(event) => set("reducedMotion", event.target.checked)} />
          Reduce motion (also stops cursor blinking)
        </label>
        <label>
          Bell
          <select value={prefs.bellStyle} onChange={(event) => set("bellStyle", event.target.value as Prefs["bellStyle"])}>
            <option value="none">None</option>
            <option value="sound">Sound</option>
            <option value="visual">Visual flash</option>
          </select>
        </label>
      </section>

      <section aria-labelledby="prefs-terminal">
        <h3 id="prefs-terminal">Terminal behavior</h3>
        <label className="check">
          <input type="checkbox" checked={prefs.screenReaderMode} onChange={(event) => set("screenReaderMode", event.target.checked)} />
          Screen reader mode (VoiceOver reads terminal output)
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.optionAsMeta} onChange={(event) => set("optionAsMeta", event.target.checked)} />
          Use Option as Meta key
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.copyOnSelect} onChange={(event) => set("copyOnSelect", event.target.checked)} />
          Copy text to the clipboard when it is selected
        </label>
        <label>
          Scrollback lines
          <input type="number" min={0} max={100000} step={1000} value={prefs.scrollback}
            onChange={(event) => set("scrollback", Math.min(100000, Math.max(0, Math.trunc(Number(event.target.value)))))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.reviewNewTabs} onChange={(event) => set("reviewNewTabs", event.target.checked)} />
          Start new tabs with submission review on
        </label>
        <p className="prefs-note">Submission review holds every Enter for approval. It is off by default; existing tabs keep their current mode.</p>
      </section>

      <section aria-labelledby="prefs-ai">
        <h3 id="prefs-ai">AI</h3>
        <label className="check">
          <input type="checkbox" checked={prefs.aiEnabled} onChange={(event) => set("aiEnabled", event.target.checked)} />
          Enable AI layer (optional)
        </label>
        <p className="prefs-note">AI stays off the critical path. Shells, tabs, colors, and keybindings work with this unchecked.</p>
      </section>

      <section aria-labelledby="prefs-reset">
        <h3 id="prefs-reset">Reset</h3>
        {!confirmReset
          ? <button type="button" onClick={() => setConfirmReset(true)}>Reset all preferences to defaults…</button>
          : <div role="group" aria-labelledby="prefs-reset-question">
            <p id="prefs-reset-question">Reset every preference, including custom colors, to the defaults? This cannot be undone.</p>
            <div className="palette-actions">
              <button type="button" autoFocus onClick={() => setConfirmReset(false)}>Cancel</button>
              <button type="button" className="danger" onClick={() => {
                onChange(DEFAULT_PREFS); setConfirmReset(false); onStatus("All preferences reset to defaults");
              }}>Reset to defaults</button>
            </div>
          </div>}
      </section>
    </aside>
  );
}

function ColorField({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  const parsed = draft.trim() === "" ? "" : parseColorInput(draft);
  const invalid = parsed === null;
  const commit = () => { if (!invalid && parsed !== value) onChange(parsed); };
  return <label className="color-field">
    <span><i aria-hidden="true" style={{ background: value || "transparent" }} />{colorLabel(name)}</span>
    <input value={draft} aria-invalid={invalid} aria-describedby={`${id}-now ${invalid ? `${id}-error` : ""}`} spellCheck={false}
      placeholder="Theme color" list="named-colors"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />
    <small id={`${id}-now`}>{value ? `Currently ${value}, ${describeColor(value)}` : "Using the theme color"}</small>
    {invalid && <small id={`${id}-error`} role="alert">Not a color. Use a name such as {Object.keys(NAMED_COLORS).slice(0, 4).join(", ")}, or #rrggbb, or rgba(r, g, b, a).</small>}
  </label>;
}
