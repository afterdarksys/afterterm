import type { ITheme } from "@xterm/xterm";

export type ThemeId = "signal" | "afterdark" | "nocturne" | "paper" | "high-contrast";

export type ThemeDef = {
  id: ThemeId;
  label: string;
  chrome: {
    ink: string;
    panel: string;
    line: string;
    text: string;
    muted: string;
    accent: string;
    danger: string;
  };
  terminal: ITheme;
};

export const THEMES: Record<ThemeId, ThemeDef> = {
  signal: {
    id: "signal",
    label: "Signal",
    chrome: {
      ink: "#07080a",
      panel: "rgba(12, 14, 18, 0.55)",
      line: "rgba(232, 184, 109, 0.28)",
      text: "#e8e4d9",
      muted: "#8a8476",
      accent: "#e8b86d",
      danger: "#ff6b4a",
    },
    terminal: {
      background: "rgba(7, 8, 10, 0.35)",
      foreground: "#e8e4d9",
      cursor: "#e8b86d",
      cursorAccent: "#07080a",
      selectionBackground: "rgba(232, 184, 109, 0.28)",
      black: "#1a1c20",
      red: "#ff6b4a",
      green: "#8fbf7a",
      yellow: "#e8b86d",
      blue: "#7aa0c4",
      magenta: "#c492b4",
      cyan: "#7dbfb3",
      white: "#e8e4d9",
      brightBlack: "#5c5850",
      brightRed: "#ff8a70",
      brightGreen: "#b4d49c",
      brightYellow: "#f3d39a",
      brightBlue: "#9cbcdc",
      brightMagenta: "#d8b0cc",
      brightCyan: "#a8d8ce",
      brightWhite: "#f7f4ea",
    },
  },
  afterdark: {
    id: "afterdark",
    label: "After Dark",
    chrome: {
      ink: "#0c1016",
      panel: "rgba(16, 22, 30, 0.6)",
      line: "rgba(90, 140, 180, 0.35)",
      text: "#d7e0ea",
      muted: "#7a8a9a",
      accent: "#7ec8e3",
      danger: "#e07070",
    },
    terminal: {
      background: "rgba(12, 16, 22, 0.4)",
      foreground: "#d7e0ea",
      cursor: "#7ec8e3",
      selectionBackground: "rgba(126, 200, 227, 0.28)",
      black: "#121820",
      red: "#e07070",
      green: "#7dba8a",
      yellow: "#d4b46a",
      blue: "#6a9cc8",
      magenta: "#b08cc0",
      cyan: "#7ec8e3",
      white: "#d7e0ea",
      brightBlack: "#5a6a7a",
      brightRed: "#f09090",
      brightGreen: "#9ad4a6",
      brightYellow: "#e8cc88",
      brightBlue: "#8cb4dc",
      brightMagenta: "#c8a8d4",
      brightCyan: "#a0dcf0",
      brightWhite: "#eef4f8",
    },
  },
  nocturne: {
    id: "nocturne",
    label: "Nocturne",
    chrome: {
      ink: "#0a0a12",
      panel: "rgba(14, 14, 24, 0.58)",
      line: "rgba(160, 140, 220, 0.28)",
      text: "#ddd6f0",
      muted: "#8a82a4",
      accent: "#c4b0f0",
      danger: "#e08090",
    },
    terminal: {
      background: "rgba(10, 10, 18, 0.4)",
      foreground: "#ddd6f0",
      cursor: "#c4b0f0",
      selectionBackground: "rgba(196, 176, 240, 0.28)",
      black: "#16161e",
      red: "#e08090",
      green: "#90c8a0",
      yellow: "#e0c890",
      blue: "#90a8e0",
      magenta: "#c4b0f0",
      cyan: "#90d0d8",
      white: "#ddd6f0",
      brightBlack: "#5a5468",
      brightRed: "#f0a0ac",
      brightGreen: "#b0dcc0",
      brightYellow: "#f0dcac",
      brightBlue: "#b0c0f0",
      brightMagenta: "#d8c8f8",
      brightCyan: "#b0e4ea",
      brightWhite: "#f4f0ff",
    },
  },
  paper: {
    id: "paper",
    label: "Paper",
    chrome: {
      ink: "#f3efe4",
      panel: "rgba(255, 252, 246, 0.72)",
      line: "rgba(40, 32, 20, 0.16)",
      text: "#2a2418",
      muted: "#7a6e58",
      accent: "#8a5a20",
      danger: "#a03020",
    },
    terminal: {
      background: "rgba(247, 243, 232, 0.55)",
      foreground: "#2a2418",
      cursor: "#8a5a20",
      selectionBackground: "rgba(138, 90, 32, 0.22)",
      black: "#2a2418",
      red: "#a03020",
      green: "#3a6a38",
      yellow: "#8a5a20",
      blue: "#2a5080",
      magenta: "#6a3870",
      cyan: "#2a6868",
      white: "#f3efe4",
      brightBlack: "#7a6e58",
      brightRed: "#c05040",
      brightGreen: "#508850",
      brightYellow: "#b07830",
      brightBlue: "#4870a8",
      brightMagenta: "#885898",
      brightCyan: "#489090",
      brightWhite: "#fffaf0",
    },
  },
  "high-contrast": {
    id: "high-contrast",
    label: "High contrast",
    chrome: {
      ink: "#000000",
      panel: "rgba(0, 0, 0, 0.85)",
      line: "#ffffff",
      text: "#ffffff",
      muted: "#c0c0c0",
      accent: "#ffff00",
      danger: "#ff4040",
    },
    terminal: {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffff00",
      selectionBackground: "#ffffff",
      selectionForeground: "#000000",
      black: "#000000",
      red: "#ff4040",
      green: "#40ff40",
      yellow: "#ffff40",
      blue: "#4040ff",
      magenta: "#ff40ff",
      cyan: "#40ffff",
      white: "#ffffff",
      brightBlack: "#808080",
      brightRed: "#ff8080",
      brightGreen: "#80ff80",
      brightYellow: "#ffff80",
      brightBlue: "#8080ff",
      brightMagenta: "#ff80ff",
      brightCyan: "#80ffff",
      brightWhite: "#ffffff",
    },
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export const TERMINAL_COLORS = [
  "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
  "selectionForeground", "selectionInactiveBackground", "overviewRulerBorder",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
] as const;
export const CHROME_COLORS = ["ink", "panel", "line", "text", "muted", "accent", "danger"] as const;
export type ThemeOverrides = {
  terminal?: Partial<Record<typeof TERMINAL_COLORS[number], string>>;
  chrome?: Partial<ThemeDef["chrome"]>;
};

// Portable JSON colors only: no CSS variables, URLs, or browser-specific parsing.
export function validColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return true;
  const match = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/.exec(value);
  return !!match && match.slice(1, 4).every((part) => Number(part) <= 255);
}

export function cleanOverrides(value: unknown): ThemeOverrides {
  const result: ThemeOverrides = {};
  if (!value || typeof value !== "object") return result;
  for (const [group, keys] of [["terminal", TERMINAL_COLORS], ["chrome", CHROME_COLORS]] as const) {
    const source = (value as Record<string, unknown>)[group];
    if (!source || typeof source !== "object") continue;
    const colors: Record<string, string> = {};
    for (const key of keys) {
      const color = (source as Record<string, unknown>)[key];
      if (validColor(color)) colors[key] = color;
    }
    if (Object.keys(colors).length) result[group] = colors;
  }
  return result;
}

export function resolveTheme(id: string, overrides?: ThemeOverrides): ThemeDef {
  const base = THEMES[(Object.prototype.hasOwnProperty.call(THEMES, id) ? id : "signal") as ThemeId];
  if (!overrides) return base;
  const clean = cleanOverrides(overrides);
  return { ...base, chrome: { ...base.chrome, ...clean.chrome }, terminal: { ...base.terminal, ...clean.terminal } };
}

export function withAlpha(theme: ITheme, transparency: number): ITheme {
  const alpha = Math.min(1, Math.max(0.2, transparency));
  const bg = theme.background ?? "#000000";
  if (bg.startsWith("rgba")) {
    return { ...theme, background: bg.replace(/[\d.]+\)$/, `${alpha})`) };
  }
  if (bg.startsWith("#") && (bg.length === 7 || bg.length === 4)) {
    const hex = bg.length === 4
      ? `#${bg[1]}${bg[1]}${bg[2]}${bg[2]}${bg[3]}${bg[3]}`
      : bg;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { ...theme, background: `rgba(${r}, ${g}, ${b}, ${alpha})` };
  }
  return theme;
}
