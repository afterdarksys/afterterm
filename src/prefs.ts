import { cleanOverrides, type ThemeOverrides } from "./themes.ts";

export type Prefs = {
  theme: string;
  themeOverrides: Record<string, ThemeOverrides>;
  fontFamily: string;
  fontSize: number;
  transparency: number;
  cursorStyle: "bar" | "block" | "underline";
  scrollback: number;
  reducedMotion: boolean;
  aiEnabled: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  theme: "signal",
  themeOverrides: {},
  fontFamily: "SF Mono, Menlo, JetBrains Mono, ui-monospace, monospace",
  fontSize: 13,
  transparency: 0.82,
  cursorStyle: "bar",
  scrollback: 10000,
  reducedMotion: false,
  aiEnabled: false,
};

type WirePrefs = {
  theme: string;
  theme_overrides?: Record<string, ThemeOverrides>;
  font_family: string;
  font_size: number;
  transparency: number;
  cursor_style: string;
  scrollback: number;
  reduced_motion: boolean;
  ai_enabled: boolean;
};

export function fromWire(wire: WirePrefs): Prefs {
  const cursor = wire.cursor_style;
  return {
    theme: wire.theme,
    themeOverrides: Object.fromEntries(Object.entries(wire.theme_overrides ?? {}).map(([id, colors]) => [id, cleanOverrides(colors)])),
    fontFamily: wire.font_family,
    fontSize: wire.font_size,
    transparency: wire.transparency,
    cursorStyle: cursor === "block" || cursor === "underline" ? cursor : "bar",
    scrollback: wire.scrollback,
    reducedMotion: wire.reduced_motion,
    aiEnabled: wire.ai_enabled,
  };
}

export function toWire(prefs: Prefs): WirePrefs {
  return {
    theme: prefs.theme,
    theme_overrides: prefs.themeOverrides,
    font_family: prefs.fontFamily,
    font_size: prefs.fontSize,
    transparency: prefs.transparency,
    cursor_style: prefs.cursorStyle,
    scrollback: prefs.scrollback,
    reduced_motion: prefs.reducedMotion,
    ai_enabled: prefs.aiEnabled,
  };
}
