import { cleanOverrides, type ThemeOverrides } from "./themes.ts";

export type BellStyle = "none" | "visual" | "sound";

export type Prefs = {
  theme: string;
  themeOverrides: Record<string, ThemeOverrides>;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  transparency: number;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  reducedMotion: boolean;
  bellStyle: BellStyle;
  optionAsMeta: boolean;
  copyOnSelect: boolean;
  screenReaderMode: boolean;
  reviewNewTabs: boolean;
  aiEnabled: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  theme: "signal",
  themeOverrides: {},
  fontFamily: "SF Mono, Menlo, JetBrains Mono, ui-monospace, monospace",
  fontSize: 13,
  lineHeight: 1,
  transparency: 0.82,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  reducedMotion: false,
  bellStyle: "none",
  optionAsMeta: false,
  copyOnSelect: false,
  screenReaderMode: true,
  reviewNewTabs: false,
  aiEnabled: false,
};

export const LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.5, 1.75, 2] as const;

type WirePrefs = {
  theme: string;
  theme_overrides?: Record<string, ThemeOverrides>;
  font_family: string;
  font_size: number;
  line_height?: number;
  transparency: number;
  cursor_style: string;
  cursor_blink?: boolean;
  scrollback: number;
  reduced_motion: boolean;
  bell_style?: string;
  option_as_meta?: boolean;
  copy_on_select?: boolean;
  screen_reader_mode?: boolean;
  review_new_tabs?: boolean;
  ai_enabled: boolean;
};

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

export function fromWire(wire: WirePrefs): Prefs {
  const cursor = wire.cursor_style;
  const bell = wire.bell_style;
  const lineHeight = Number(wire.line_height);
  return {
    theme: wire.theme,
    themeOverrides: Object.fromEntries(Object.entries(wire.theme_overrides ?? {}).map(([id, colors]) => [id, cleanOverrides(colors)])),
    fontFamily: wire.font_family,
    fontSize: wire.font_size,
    lineHeight: lineHeight >= 1 && lineHeight <= 2 ? lineHeight : DEFAULT_PREFS.lineHeight,
    transparency: wire.transparency,
    cursorStyle: cursor === "block" || cursor === "underline" ? cursor : "bar",
    cursorBlink: bool(wire.cursor_blink, DEFAULT_PREFS.cursorBlink),
    scrollback: wire.scrollback,
    reducedMotion: wire.reduced_motion,
    bellStyle: bell === "visual" || bell === "sound" ? bell : "none",
    optionAsMeta: bool(wire.option_as_meta, DEFAULT_PREFS.optionAsMeta),
    copyOnSelect: bool(wire.copy_on_select, DEFAULT_PREFS.copyOnSelect),
    screenReaderMode: bool(wire.screen_reader_mode, DEFAULT_PREFS.screenReaderMode),
    reviewNewTabs: bool(wire.review_new_tabs, DEFAULT_PREFS.reviewNewTabs),
    aiEnabled: wire.ai_enabled,
  };
}

export function toWire(prefs: Prefs): WirePrefs {
  return {
    theme: prefs.theme,
    theme_overrides: prefs.themeOverrides,
    font_family: prefs.fontFamily,
    font_size: prefs.fontSize,
    line_height: prefs.lineHeight,
    transparency: prefs.transparency,
    cursor_style: prefs.cursorStyle,
    cursor_blink: prefs.cursorBlink,
    scrollback: prefs.scrollback,
    reduced_motion: prefs.reducedMotion,
    bell_style: prefs.bellStyle,
    option_as_meta: prefs.optionAsMeta,
    copy_on_select: prefs.copyOnSelect,
    screen_reader_mode: prefs.screenReaderMode,
    review_new_tabs: prefs.reviewNewTabs,
    ai_enabled: prefs.aiEnabled,
  };
}
