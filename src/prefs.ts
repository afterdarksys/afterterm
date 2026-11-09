import { sanitizeConnections, type SavedConnection } from "./sessions.ts";
import { cleanOverrides, type ThemeOverrides } from "./themes.ts";

export type BellStyle = "none" | "visual" | "sound";
export type SecretSource = "env" | "file";
export type RestoreSessions = "off" | "local" | "reconnect";

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
  blocksEnabled: boolean;
  blocksGutter: boolean;
  blocksShellIntegration: boolean;
  blocksShowExit: boolean;
  blocksShowDuration: boolean;
  blocksShowTimestamps: boolean;
  driveEndpoint: string;
  driveRegion: string;
  driveBucket: string;
  driveAccessKeyId: string;
  driveSecretSource: SecretSource;
  driveSecretPath: string;
  newTabDirectory: boolean;
  confirmCloseBusy: boolean;
  openLinks: boolean;
  markBackgroundTabs: boolean;
  notifySystem: boolean;
  restoreSessions: RestoreSessions;
  connections: SavedConnection[];
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
  blocksEnabled: false,
  blocksGutter: true,
  blocksShellIntegration: false,
  blocksShowExit: true,
  blocksShowDuration: true,
  blocksShowTimestamps: false,
  driveEndpoint: "",
  driveRegion: "us-east-1",
  driveBucket: "",
  driveAccessKeyId: "",
  driveSecretSource: "env",
  driveSecretPath: "",
  newTabDirectory: true,
  confirmCloseBusy: true,
  openLinks: true,
  markBackgroundTabs: true,
  notifySystem: false,
  restoreSessions: "off",
  connections: [],
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
  blocks_enabled?: boolean;
  blocks_gutter?: boolean;
  blocks_shell_integration?: boolean;
  blocks_show_exit?: boolean;
  blocks_show_duration?: boolean;
  blocks_show_timestamps?: boolean;
  drive_endpoint?: string;
  drive_region?: string;
  drive_bucket?: string;
  drive_access_key_id?: string;
  drive_secret_source?: string;
  drive_secret_path?: string;
  new_tab_directory?: boolean;
  confirm_close_busy?: boolean;
  open_links?: boolean;
  mark_background_tabs?: boolean;
  notify_system?: boolean;
  restore_sessions?: string;
  connections?: unknown;
};

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Matches Rust `char::is_control`: C0, DEL, and C1. */
export function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Stored Drive endpoint. Empty stays empty. A valid endpoint is rebuilt as
 * `https://host[:port]/s3`, keeping an explicit port (including 443). Spaces, newlines,
 * and other controls are rejected on the original string. Invalid input is null.
 * The URL constructor only checks the rebuilt string; its toString() can drop :443.
 */
export function normalizeEndpoint(input: string): string | null {
  if (hasControl(input) || /\s/u.test(input)) return null;
  const raw = input;
  if (raw === "") return "";
  if (raw.length > 200) return null;
  if (raw.includes("@") || raw.includes("?") || raw.includes("#")) return null;
  if (!raw.slice(0, 8).toLowerCase().startsWith("https://")) return null;
  const rest = raw.slice(8);
  let authority = "";
  let path = "";
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 1) return null;
    const after = rest.slice(close + 1);
    if (after.startsWith(":")) {
      const slash = after.indexOf("/");
      if (slash < 0) return null;
      authority = rest.slice(0, close + 1) + after.slice(0, slash);
      path = after.slice(slash);
    } else if (after.startsWith("/")) {
      authority = rest.slice(0, close + 1);
      path = after;
    } else {
      return null;
    }
  } else {
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    authority = rest.slice(0, slash);
    path = rest.slice(slash);
  }
  if (path !== "/s3" && path !== "/s3/") return null;
  if (authority.includes("@") || authority.length === 0) return null;

  let host = authority;
  let port: number | null = null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    host = authority.slice(1, close);
    const tail = authority.slice(close + 1);
    if (tail === "") port = null;
    else if (tail.startsWith(":")) {
      const parsed = parsePort(tail.slice(1));
      if (parsed === null) return null;
      port = parsed;
    } else return null;
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0 && /^\d+$/.test(authority.slice(colon + 1))) {
      host = authority.slice(0, colon);
      const parsed = parsePort(authority.slice(colon + 1));
      if (parsed === null) return null;
      port = parsed;
    }
  }
  if (host.length === 0) return null;
  const bracketed = host.includes(":");
  const displayHost = bracketed ? `[${host}]` : host;
  const probe = `https://${displayHost}${port === null ? "" : `:${port}`}/s3`;
  let parsed: URL;
  try {
    parsed = new URL(probe);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/s3") {
    return null;
  }
  const shown = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
  return `https://${shown}${port === null ? "" : `:${port}`}/s3`;
}

function parsePort(digits: string): number | null {
  if (!/^\d{1,5}$/.test(digits)) return null;
  const port = Number(digits);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export function regionError(region: string): string | null {
  return /^[a-z0-9-]{1,32}$/.test(region) ? null : "Signing region is not valid";
}

export function bucketError(bucket: string): string | null {
  if (bucket === "") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(bucket) || bucket.includes("..")) return "Bucket name is not valid";
  return null;
}

export function accessKeyError(key: string): string | null {
  if (key === "") return null;
  return /^[A-Za-z0-9]{1,128}$/.test(key) ? null : "Access key id is not valid";
}

export function secretPathError(path: string): string | null {
  if (path.length > 4096 || hasControl(path)) return "Secret file path is not valid";
  return null;
}

export function fromWire(wire: WirePrefs): Prefs {
  const cursor = wire.cursor_style;
  const bell = wire.bell_style;
  const lineHeight = Number(wire.line_height);
  const endpoint = typeof wire.drive_endpoint === "string" ? normalizeEndpoint(wire.drive_endpoint) : "";
  const region = wire.drive_region === undefined ? DEFAULT_PREFS.driveRegion : wire.drive_region;
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
    blocksEnabled: bool(wire.blocks_enabled, DEFAULT_PREFS.blocksEnabled),
    blocksGutter: bool(wire.blocks_gutter, DEFAULT_PREFS.blocksGutter),
    blocksShellIntegration: bool(wire.blocks_shell_integration, DEFAULT_PREFS.blocksShellIntegration),
    blocksShowExit: bool(wire.blocks_show_exit, DEFAULT_PREFS.blocksShowExit),
    blocksShowDuration: bool(wire.blocks_show_duration, DEFAULT_PREFS.blocksShowDuration),
    blocksShowTimestamps: bool(wire.blocks_show_timestamps, DEFAULT_PREFS.blocksShowTimestamps),
    driveEndpoint: endpoint ?? "",
    driveRegion: region === "" ? "" : regionError(region) ? DEFAULT_PREFS.driveRegion : region,
    driveBucket: typeof wire.drive_bucket === "string" && bucketError(wire.drive_bucket) === null ? wire.drive_bucket : "",
    driveAccessKeyId: typeof wire.drive_access_key_id === "string" && accessKeyError(wire.drive_access_key_id) === null ? wire.drive_access_key_id : "",
    driveSecretSource: wire.drive_secret_source === "file" ? "file" : "env",
    driveSecretPath: typeof wire.drive_secret_path === "string" && secretPathError(wire.drive_secret_path) === null ? wire.drive_secret_path : "",
    newTabDirectory: bool(wire.new_tab_directory, DEFAULT_PREFS.newTabDirectory),
    confirmCloseBusy: bool(wire.confirm_close_busy, DEFAULT_PREFS.confirmCloseBusy),
    openLinks: bool(wire.open_links, DEFAULT_PREFS.openLinks),
    markBackgroundTabs: bool(wire.mark_background_tabs, DEFAULT_PREFS.markBackgroundTabs),
    notifySystem: bool(wire.notify_system, DEFAULT_PREFS.notifySystem),
    restoreSessions: wire.restore_sessions === "local" || wire.restore_sessions === "reconnect" ? wire.restore_sessions : "off",
    connections: sanitizeConnections(wire.connections),
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
    blocks_enabled: prefs.blocksEnabled,
    blocks_gutter: prefs.blocksGutter,
    blocks_shell_integration: prefs.blocksShellIntegration,
    blocks_show_exit: prefs.blocksShowExit,
    blocks_show_duration: prefs.blocksShowDuration,
    blocks_show_timestamps: prefs.blocksShowTimestamps,
    drive_endpoint: prefs.driveEndpoint,
    drive_region: prefs.driveRegion,
    drive_bucket: prefs.driveBucket,
    drive_access_key_id: prefs.driveAccessKeyId,
    drive_secret_source: prefs.driveSecretSource,
    drive_secret_path: prefs.driveSecretPath,
    new_tab_directory: prefs.newTabDirectory,
    confirm_close_busy: prefs.confirmCloseBusy,
    open_links: prefs.openLinks,
    mark_background_tabs: prefs.markBackgroundTabs,
    notify_system: prefs.notifySystem,
    restore_sessions: prefs.restoreSessions,
    connections: prefs.connections,
  };
}
