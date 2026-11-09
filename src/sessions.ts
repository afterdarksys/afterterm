import type { ConsoleConfig } from "./console.ts";
import { hasControl } from "./prefs.ts";
import { sshDestination, type SshTarget } from "./ssh.ts";

/** Where a tab was started. Unset means a local shell. SAH arguments are never saved. */
export type TabOrigin =
  | { kind: "local" }
  | { kind: "ssh"; target: SshTarget }
  | { kind: "sah" }
  | { kind: "serial" };

export type SpawnRemote =
  | { kind: "sah"; args: string[] }
  | { kind: "ssh"; target: SshTarget; title: string };

export type NewTabPlan = {
  origin: TabOrigin;
  cwd: string | null;
  remote: SpawnRemote | null;
  note: string | null;
};

export const SAH_NOTE = "SAH is not duplicated. This tab is a local shell";
export const SERIAL_NOTE = "The console stays on its own tab";
export const SPLIT_BUSY = "Close the current split before opening another";
export const CONNECTION_INVALID = "Saved connection is not valid";
export const CONNECTION_TOO_MANY = "Too many saved connections";
export const CONNECTION_CAP = 32;
export const WORKSPACE_CAP = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[a-z0-9-]{1,64}$/;
const SSH_FIELDS = new Set(["id", "name", "kind", "host", "user", "port"]);
const SERIAL_FIELDS = new Set(["id", "name", "kind", "config"]);
const SERIAL_CONFIG_FIELDS = new Set([
  "path", "baud", "data_bits", "parity", "stop_bits", "flow_control", "production",
  "lineEnding", "backspace", "localEcho", "profileId", "identity", "autoReconnect",
]);

export type SavedConnection =
  | { id: string; name: string; kind: "ssh"; host: string; user: string | null; port: number | null }
  | { id: string; name: string; kind: "serial"; config: ConsoleConfig };

export type SplitOrientation = "right" | "down";
export type Split = { orientation: SplitOrientation; keys: [string, string]; focus: 0 | 1 };

export type CloseInfo =
  | null
  | { ok: false }
  | { ok: true; pid: number | null; foreground_pgid: number | null };

export type WorkspaceTab =
  | { kind: "local"; cwd: string | null }
  | { kind: "ssh"; host: string; user: string | null; port: number | null }
  | { kind: "serial"; config: ConsoleConfig };

export type WorkspaceSplit = { orientation: SplitOrientation; index: [number, number]; focus: 0 | 1 };
export type WorkspaceFile = { version: 1; active: number; split: WorkspaceSplit | null; tabs: WorkspaceTab[] };

export type SessionSnapshot = {
  key: string;
  origin?: TabOrigin | null;
  reportedCwd?: string | null;
  spawnCwd?: string | null;
  consoleConfig?: ConsoleConfig | null;
};

export type RestoredSession = {
  kind: "local" | "ssh" | "serial";
  cwd: string | null;
  ssh: { target: SshTarget; title: string } | null;
  config: ConsoleConfig | null;
  title: string;
};

export type RestorePlan = { tabs: RestoredSession[]; active: number; split: WorkspaceSplit | null };

function scalarLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function onlyKeys(value: object, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Absolute local path. Empty, relative, remote, and control-bearing text become null. */
export function cleanLocalCwd(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) return null;
  if (!value.startsWith("/") || value.includes("\0") || hasControl(value)) return null;
  return value;
}

export function canonicalSshTarget(input: { host: unknown; user?: unknown; port?: unknown }): SshTarget | null {
  if (typeof input.host !== "string") return null;
  const host = input.host.trim();
  let user: string | null = null;
  if (input.user != null) {
    if (typeof input.user !== "string") return null;
    const trimmed = input.user.trim();
    user = trimmed === "" ? null : trimmed;
  }
  let port: number | null = null;
  if (input.port != null) {
    if (typeof input.port !== "number" || !Number.isInteger(input.port)) return null;
    port = input.port;
  }
  if (!sshDestination({ host, user, port })) return null;
  return { host, user, port };
}

/**
 * Directory and connection for a tab opened from `origin`.
 * A reported cwd of "" is set and must not fall through to the process cwd.
 * SSH is duplicated as host, user, and port only. SAH and serial are not duplicated.
 */
export function planNewTab(input: {
  origin?: TabOrigin | null;
  follow: boolean;
  reportedCwd?: string | null;
  ptyCwd?: string | null;
}): NewTabPlan {
  const origin = input.origin ?? { kind: "local" };
  const local = { origin: { kind: "local" as const }, cwd: null, remote: null, note: null };
  if (origin.kind === "serial") return { ...local, note: SERIAL_NOTE };
  if (origin.kind === "sah") return { ...local, note: SAH_NOTE };
  if (origin.kind === "ssh") {
    if (!input.follow) return local;
    const target = canonicalSshTarget(origin.target);
    if (!target) return local;
    const title = `ssh ${sshDestination(target)}`;
    return { origin: { kind: "ssh", target }, cwd: null, remote: { kind: "ssh", target, title }, note: null };
  }
  if (!input.follow) return local;
  const cwd = typeof input.reportedCwd === "string" ? cleanLocalCwd(input.reportedCwd) : cleanLocalCwd(input.ptyCwd);
  return { ...local, cwd };
}

/**
 * Ask before closing a live session whose foreground is not the shell, or whose
 * state could not be read. A gone process (pid null) closes without asking.
 * Serial running or starting asks before any pty lookup.
 */
export function closeNeedsConfirm(input: {
  confirm: boolean;
  hasSession: boolean;
  status: string;
  serial: boolean;
  info: CloseInfo;
}): boolean {
  if (!input.confirm || !input.hasSession) return false;
  if (input.status === "exited" || input.status === "error") return false;
  if (input.serial && (input.status === "running" || input.status === "starting")) return true;
  if (input.info == null || input.info.ok === false) return true;
  if (input.info.pid == null) return false;
  if (input.info.foreground_pgid == null) return true;
  return input.info.foreground_pgid !== input.info.pid;
}

/** http(s) link for a modifier click. The handler replaces xterm's window.open. */
export function linkToOpen(uri: string, modifier: boolean, enabled: boolean): string | null {
  if (!modifier || !enabled) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  return url.href;
}

/**
 * OSC 7 file URL when it names this machine. A dotted host that is not the
 * machine is rejected, so a remote path is never used as a local directory.
 */
export function localOsc7Path(payload: string, hostnames: readonly string[]): string | null {
  if (hasControl(payload) || payload.includes("\0")) return null;
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || url.username || url.password) return null;
  // Node keeps brackets on an IPv6 file host. Browsers report the inner host.
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const allowed = new Set(["", "localhost", "127.0.0.1", "::1"]);
  for (const name of hostnames) {
    const normalized = name.toLowerCase();
    allowed.add(normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized);
  }
  if (!allowed.has(host)) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!path.startsWith("/") || path.length > 4096 || path.includes("\0") || hasControl(path)) return null;
  return path;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = scalarLength(name);
  if (length < 1 || length > 64 || hasControl(name)) return null;
  return name;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string" || !UUID.test(value)) return null;
  return value.toLowerCase();
}

/** Serial device settings only. Unknown keys, including a password, fail the whole config. */
export function cleanSerialConfig(value: unknown): ConsoleConfig | null {
  if (!isRecord(value) || !onlyKeys(value, SERIAL_CONFIG_FIELDS)) return null;
  const path = value.path;
  if (typeof path !== "string" || path.length < 1 || path.length > 256 || !path.startsWith("/dev/") || path.includes("\0") || hasControl(path)) return null;
  const baud = value.baud;
  const dataBits = value.data_bits;
  const stopBits = value.stop_bits;
  if (typeof baud !== "number" || !Number.isInteger(baud) || baud < 1 || baud > 4_000_000) return null;
  if (typeof dataBits !== "number" || !Number.isInteger(dataBits) || dataBits < 5 || dataBits > 8) return null;
  if (typeof stopBits !== "number" || (stopBits !== 1 && stopBits !== 2)) return null;
  if (value.parity !== "none" && value.parity !== "even" && value.parity !== "odd") return null;
  if (value.flow_control !== "none" && value.flow_control !== "hardware" && value.flow_control !== "software") return null;
  if (typeof value.production !== "boolean" || typeof value.localEcho !== "boolean") return null;
  if (value.lineEnding !== "cr" && value.lineEnding !== "lf" && value.lineEnding !== "crlf") return null;
  if (value.backspace !== "bs" && value.backspace !== "del") return null;
  if (typeof value.profileId !== "string" || !PROFILE_ID.test(value.profileId)) return null;
  const config: ConsoleConfig = {
    path,
    baud,
    data_bits: dataBits,
    parity: value.parity,
    stop_bits: stopBits,
    flow_control: value.flow_control,
    production: value.production,
    lineEnding: value.lineEnding,
    backspace: value.backspace,
    localEcho: value.localEcho,
    profileId: value.profileId,
  };
  if ("identity" in value) {
    const identity = value.identity;
    if (typeof identity !== "string" || identity.length < 1 || identity.length > 256 || identity.includes("\0") || hasControl(identity)) return null;
    config.identity = identity;
  }
  if ("autoReconnect" in value) {
    if (typeof value.autoReconnect !== "boolean") return null;
    config.autoReconnect = value.autoReconnect;
  }
  return config;
}

/** Strict canonical connection. Unknown keys return null so a password is not stripped and kept. */
export function cleanConnection(value: unknown): SavedConnection | null {
  if (!isRecord(value)) return null;
  const id = cleanId(value.id);
  const name = cleanName(value.name);
  if (!id || !name) return null;
  if (value.kind === "ssh") {
    if (!onlyKeys(value, SSH_FIELDS)) return null;
    const target = canonicalSshTarget({ host: value.host, user: value.user, port: value.port });
    if (!target) return null;
    return { id, name, kind: "ssh", host: target.host, user: target.user, port: target.port };
  }
  if (value.kind === "serial") {
    if (!onlyKeys(value, SERIAL_FIELDS)) return null;
    const config = cleanSerialConfig(value.config);
    if (!config) return null;
    return { id, name, kind: "serial", config };
  }
  return null;
}

/** Invalid and duplicate ids are rejected before the 32-connection cap. */
export function connectionSaveError(existing: readonly { id: string }[], candidate: unknown): string | null {
  const clean = cleanConnection(candidate);
  if (!clean || existing.some((item) => item.id.toLowerCase() === clean.id)) return CONNECTION_INVALID;
  if (existing.length >= CONNECTION_CAP) return CONNECTION_TOO_MANY;
  return null;
}

/** Load path. Bad entries are dropped, the first id wins, and the list stops at 32. */
export function sanitizeConnections(value: unknown): SavedConnection[] {
  if (!Array.isArray(value)) return [];
  const kept: SavedConnection[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const clean = cleanConnection(item);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    kept.push(clean);
    if (kept.length >= CONNECTION_CAP) break;
  }
  return kept;
}

export function openSplit(current: Split | null, orientation: SplitOrientation, sourceKey: string, newKey: string): { split: Split; error: string | null } {
  if (current) return { split: current, error: SPLIT_BUSY };
  return { split: { orientation, keys: [sourceKey, newKey], focus: 1 }, error: null };
}

/** Null when `key` is outside the pair. The caller clears the split. */
export function selectInSplit(split: Split, key: string): Split | null {
  const index = split.keys.indexOf(key);
  if (index !== 0 && index !== 1) return null;
  return { ...split, focus: index };
}

export function closeInSplit(split: Split | null, key: string): { split: Split | null; focusKey: string | null } {
  if (!split) return { split: null, focusKey: null };
  const index = split.keys.indexOf(key);
  if (index !== 0 && index !== 1) return { split, focusKey: null };
  return { split: null, focusKey: split.keys[index === 0 ? 1 : 0] };
}

export function serialTitle(config: ConsoleConfig): string {
  const name = config.path.split("/").pop() || config.path;
  return `${name} · ${config.baud}${config.production ? " · prod" : ""}`;
}

function workspaceTab(tab: SessionSnapshot): WorkspaceTab | null {
  const origin = tab.origin ?? { kind: "local" };
  if (origin.kind === "sah") return null;
  if (origin.kind === "serial") {
    const config = tab.consoleConfig ? cleanSerialConfig(tab.consoleConfig) : null;
    return config ? { kind: "serial", config } : null;
  }
  if (origin.kind === "ssh") {
    const target = canonicalSshTarget(origin.target);
    return target ? { kind: "ssh", host: target.host, user: target.user, port: target.port } : null;
  }
  const raw = typeof tab.reportedCwd === "string" ? tab.reportedCwd : tab.spawnCwd;
  return { kind: "local", cwd: cleanLocalCwd(raw) };
}

/** Saved sessions. SAH tabs are omitted. Scrollback, secrets, and review state are not included. */
export function snapshotWorkspace(input: { tabs: SessionSnapshot[]; activeKey: string; split: Split | null }): WorkspaceFile {
  const kept: { tab: WorkspaceTab; source: number }[] = [];
  input.tabs.forEach((tab, source) => {
    if (kept.length >= WORKSPACE_CAP) return;
    const saved = workspaceTab(tab);
    if (saved) kept.push({ tab: saved, source });
  });
  let split: WorkspaceSplit | null = null;
  if (input.split && (input.split.focus === 0 || input.split.focus === 1)) {
    const sources = input.split.keys.map((key) => input.tabs.findIndex((tab) => tab.key === key));
    const index = sources.map((source) => kept.findIndex((item) => item.source === source));
    if (index[0] >= 0 && index[1] >= 0 && index[0] !== index[1] && (input.split.orientation === "right" || input.split.orientation === "down")) {
      split = { orientation: input.split.orientation, index: [index[0], index[1]], focus: input.split.focus };
    }
  }
  const activeSource = input.tabs.findIndex((tab) => tab.key === input.activeKey);
  const active = kept.findIndex((item) => item.source === activeSource);
  return { version: 1, active: active < 0 ? 0 : active, split, tabs: kept.map((item) => item.tab) };
}

function restoreOne(value: unknown, mode: "local" | "reconnect"): { session: RestoredSession } | null {
  if (!isRecord(value)) return null;
  if (value.kind === "local") {
    if (!onlyKeys(value, new Set(["kind", "cwd"]))) return null;
    return { session: { kind: "local", cwd: cleanLocalCwd(value.cwd), ssh: null, config: null, title: "shell" } };
  }
  if (mode === "local") return null;
  if (value.kind === "ssh") {
    if (!onlyKeys(value, new Set(["kind", "host", "user", "port"]))) return null;
    const target = canonicalSshTarget({ host: value.host, user: value.user, port: value.port });
    if (!target) return null;
    const title = `ssh ${sshDestination(target)}`;
    return { session: { kind: "ssh", cwd: null, ssh: { target, title }, config: null, title } };
  }
  if (value.kind === "serial") {
    if (!onlyKeys(value, new Set(["kind", "config"]))) return null;
    const config = cleanSerialConfig(value.config);
    if (!config) return null;
    return { session: { kind: "serial", cwd: null, ssh: null, config, title: serialTitle(config) } };
  }
  return null;
}

function restoreSplit(value: unknown, sources: number[]): WorkspaceSplit | null {
  if (!isRecord(value) || !onlyKeys(value, new Set(["orientation", "index", "focus"]))) return null;
  const { orientation, index, focus } = value;
  if (orientation !== "right" && orientation !== "down") return null;
  if (focus !== 0 && focus !== 1) return null;
  if (!Array.isArray(index) || index.length !== 2 || !index.every((item) => Number.isInteger(item))) return null;
  const mapped = index.map((item) => sources.indexOf(item));
  if (mapped[0] < 0 || mapped[1] < 0 || mapped[0] === mapped[1]) return null;
  return { orientation, index: [mapped[0], mapped[1]], focus };
}

/** Null means the caller opens one local shell. `local` drops SSH and serial tabs. */
export function restorePlan(file: unknown, mode: string): RestorePlan | null {
  if (mode !== "local" && mode !== "reconnect") return null;
  if (!isRecord(file) || file.version !== 1 || !Array.isArray(file.tabs) || file.tabs.length === 0) return null;
  const kept: { session: RestoredSession; source: number }[] = [];
  for (let source = 0; source < file.tabs.length && source < WORKSPACE_CAP; source += 1) {
    const restored = restoreOne(file.tabs[source], mode);
    if (restored) kept.push({ session: restored.session, source });
  }
  if (kept.length === 0) return null;
  const sources = kept.map((item) => item.source);
  const active = Number.isInteger(file.active) ? sources.indexOf(file.active as number) : -1;
  return {
    tabs: kept.map((item) => item.session),
    active: active < 0 ? 0 : active,
    split: restoreSplit(file.split, sources),
  };
}
