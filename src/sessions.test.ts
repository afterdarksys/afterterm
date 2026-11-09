import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsoleConfig } from "./console.ts";
import {
  cleanConnection, cleanLocalCwd, cleanSerialConfig, closeInSplit, closeNeedsConfirm, CONNECTION_CAP,
  connectionSaveError, linkToOpen, localOsc7Path, openSplit, planNewTab, restorePlan, SAH_NOTE,
  sanitizeConnections, selectInSplit, SERIAL_NOTE, snapshotWorkspace, SPLIT_BUSY, type SavedConnection,
  type SessionSnapshot, type Split,
} from "./sessions.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const ID_B = "00000000-0000-4000-8000-000000000002";

function serialConfig(extra: Record<string, unknown> = {}): ConsoleConfig {
  return {
    path: "/dev/tty.usb", baud: 9600, data_bits: 8, parity: "none", stop_bits: 1,
    flow_control: "none", production: true, lineEnding: "cr", backspace: "del",
    localEcho: false, profileId: "generic", ...extra,
  };
}

function sshConnection(extra: Record<string, unknown> = {}): SavedConnection {
  return { id: ID, name: "lab", kind: "ssh", host: "web1", user: "alice", port: 2222, ...extra };
}

describe("new tab directory", () => {
  it("duplicates SSH host, user, and port and never a directory", () => {
    const plan = planNewTab({
      origin: { kind: "ssh", target: { host: " web1 ", user: "alice", port: 2222 } },
      follow: true,
      ptyCwd: "/tmp",
      reportedCwd: "/home/alice",
    });
    assert.deepEqual(plan, {
      origin: { kind: "ssh", target: { host: "web1", user: "alice", port: 2222 } },
      cwd: null,
      remote: { kind: "ssh", target: { host: "web1", user: "alice", port: 2222 }, title: "ssh alice@web1" },
      note: null,
    });
  });

  it("does not duplicate SAH or a serial console", () => {
    assert.equal(planNewTab({ origin: { kind: "sah" }, follow: true, ptyCwd: "/tmp" }).note, SAH_NOTE);
    assert.equal(planNewTab({ origin: { kind: "sah" }, follow: true }).cwd, null);
    assert.equal(planNewTab({ origin: { kind: "serial" }, follow: true, ptyCwd: "/tmp" }).note, SERIAL_NOTE);
    assert.equal(planNewTab({ origin: { kind: "serial" }, follow: true }).remote, null);
  });

  it("uses a reported cwd, including empty, and does not fall through to the process cwd", () => {
    assert.equal(planNewTab({ follow: true, reportedCwd: "/work/app", ptyCwd: "/tmp" }).cwd, "/work/app");
    assert.equal(planNewTab({ follow: true, reportedCwd: "", ptyCwd: "/tmp" }).cwd, null);
    assert.equal(planNewTab({ follow: true, reportedCwd: "relative", ptyCwd: "/tmp" }).cwd, null);
    assert.equal(planNewTab({ follow: true, ptyCwd: "/tmp" }).cwd, "/tmp");
    assert.equal(planNewTab({ follow: false, ptyCwd: "/tmp", reportedCwd: "/work" }).cwd, null);
  });

  it("rejects a bad SSH target and an unsafe directory", () => {
    const bad = planNewTab({ origin: { kind: "ssh", target: { host: "web1;echo", user: null, port: null } }, follow: true });
    assert.deepEqual(bad.origin, { kind: "local" });
    assert.equal(bad.remote, null);
    assert.equal(cleanLocalCwd("/tmp/ok"), "/tmp/ok");
    assert.equal(cleanLocalCwd("/tmp/bad\n"), null);
    assert.equal(cleanLocalCwd("C:\\Windows"), null);
    assert.equal(cleanLocalCwd(`/${"a".repeat(4096)}`), null);
  });
});

describe("close confirmation", () => {
  const base = { confirm: true, hasSession: true, status: "running", serial: false };

  it("asks when the foreground is not the shell, the lookup failed, or a console is open", () => {
    assert.equal(closeNeedsConfirm({ ...base, info: { ok: true, pid: 4, foreground_pgid: 9 } }), true);
    assert.equal(closeNeedsConfirm({ ...base, info: { ok: true, pid: 4, foreground_pgid: null } }), true);
    assert.equal(closeNeedsConfirm({ ...base, info: null }), true);
    assert.equal(closeNeedsConfirm({ ...base, info: { ok: false } }), true);
    assert.equal(closeNeedsConfirm({ ...base, serial: true, status: "starting", info: null }), true);
  });

  it("closes without asking when the shell is idle, the process is gone, or review is skipped", () => {
    assert.equal(closeNeedsConfirm({ ...base, info: { ok: true, pid: 4, foreground_pgid: 4 } }), false);
    assert.equal(closeNeedsConfirm({ ...base, info: { ok: true, pid: null, foreground_pgid: 9 } }), false);
    assert.equal(closeNeedsConfirm({ ...base, status: "exited", info: null }), false);
    assert.equal(closeNeedsConfirm({ ...base, status: "error", info: null }), false);
    assert.equal(closeNeedsConfirm({ ...base, confirm: false, info: null }), false);
    assert.equal(closeNeedsConfirm({ ...base, hasSession: false, info: null }), false);
  });
});

describe("links and OSC 7", () => {
  it("opens only a modifier-clicked http(s) link without credentials", () => {
    assert.equal(linkToOpen("https://example.com/a", true, true), "https://example.com/a");
    assert.equal(linkToOpen("http://example.com", true, true), "http://example.com/");
    assert.equal(linkToOpen("https://user:secret@example.com", true, true), null);
    assert.equal(linkToOpen("https://user@example.com", true, true), null);
    assert.equal(linkToOpen("file:///etc/passwd", true, true), null);
    assert.equal(linkToOpen("https://example.com", false, true), null);
    assert.equal(linkToOpen("https://example.com", true, false), null);
  });

  it("accepts a local file URL and rejects a remote host", () => {
    assert.equal(localOsc7Path("file:///tmp/work", []), "/tmp/work");
    assert.equal(localOsc7Path("file://localhost/tmp/work", []), "/tmp/work");
    assert.equal(localOsc7Path("file://[::1]/tmp/work", []), "/tmp/work");
    assert.equal(localOsc7Path("file://MyHost/tmp/work", ["myhost"]), "/tmp/work");
    assert.equal(localOsc7Path("file:///tmp/my%20dir", []), "/tmp/my dir");
    assert.equal(localOsc7Path("file://web1.example/home/alice", ["myhost"]), null);
    assert.equal(localOsc7Path("file://user@localhost/tmp", []), null);
    assert.equal(localOsc7Path("file:///tmp/bad%ZZ", []), null);
    assert.equal(localOsc7Path("file:///tmp/bad\n", []), null);
  });
});

describe("saved connections", () => {
  it("canonicalizes SSH and drops a secret or a bad entry on load", () => {
    const cleaned = sanitizeConnections([
      { id: ID.toUpperCase(), name: "  lab  ", kind: "ssh", host: "web1", user: "", port: 2222 },
      { id: ID, name: "second", kind: "ssh", host: "web1", user: null, port: null },
      { ...sshConnection({ id: ID_B }), password: "nope" },
      { id: ID_B, name: "console", kind: "serial", config: { ...serialConfig(), password: "nope" } },
      { id: "not-a-uuid", name: "x", kind: "ssh", host: "web1" },
    ]);
    assert.deepEqual(cleaned, [{ id: ID, name: "lab", kind: "ssh", host: "web1", user: null, port: 2222 }]);
  });

  it("keeps serial device settings and rejects an empty identity", () => {
    const config = serialConfig({ identity: "usb-1", autoReconnect: false });
    const saved = cleanConnection({ id: ID, name: "console", kind: "serial", config });
    assert.deepEqual(saved, { id: ID, name: "console", kind: "serial", config });
    assert.equal(cleanSerialConfig(serialConfig({ identity: "" })), null);
    assert.equal(cleanSerialConfig(serialConfig({ baud: 2222.5 })), null);
    assert.equal(cleanConnection({ id: ID, name: "lab", kind: "ssh", host: "web1", port: 2222.5 }), null);
    assert.equal(cleanConnection({ id: ID, name: "   ", kind: "ssh", host: "web1" }), null);
  });

  it("rejects an invalid candidate before the cap, then rejects a 33rd valid one", () => {
    const existing = Array.from({ length: CONNECTION_CAP }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    const fresh = sshConnection({ id: "00000000-0000-4000-8000-0000000000ff" });
    assert.equal(connectionSaveError(existing, { ...fresh, password: "nope" }), "Saved connection is not valid");
    assert.equal(connectionSaveError(existing, sshConnection()), "Saved connection is not valid");
    assert.equal(connectionSaveError(existing, fresh), "Too many saved connections");
    assert.equal(connectionSaveError([], sshConnection()), null);
    const many = Array.from({ length: 40 }, (_, index) => sshConnection({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, name: "same" }));
    assert.equal(sanitizeConnections(many).length, CONNECTION_CAP);
  });
});

describe("split panes", () => {
  it("opens one pair, moves focus inside it, and collapses when a pane closes", () => {
    const opened = openSplit(null, "right", "tab-1", "tab-2");
    assert.deepEqual(opened.split, { orientation: "right", keys: ["tab-1", "tab-2"], focus: 1 });
    assert.equal(openSplit(opened.split, "down", "tab-1", "tab-3").error, SPLIT_BUSY);
    assert.equal(openSplit(opened.split, "down", "tab-1", "tab-3").split, opened.split);
    assert.deepEqual(selectInSplit(opened.split, "tab-1"), { ...opened.split, focus: 0 });
    assert.equal(selectInSplit(opened.split, "tab-9"), null);
    assert.deepEqual(closeInSplit(opened.split, "tab-2"), { split: null, focusKey: "tab-1" });
    assert.deepEqual(closeInSplit(opened.split, "tab-9"), { split: opened.split, focusKey: null });
    assert.deepEqual(closeInSplit(null, "tab-1"), { split: null, focusKey: null });
  });
});

describe("workspace", () => {
  const local = (key: string, cwd: string | null = "/work"): SessionSnapshot => ({ key, origin: { kind: "local" }, spawnCwd: cwd });

  it("skips SAH and invalid sessions and keeps an invalid local directory as null", () => {
    const split: Split = { orientation: "down", keys: ["a", "b"], focus: 0 };
    const file = snapshotWorkspace({
      tabs: [
        { key: "a", origin: { kind: "sah" }, spawnCwd: "/tmp" },
        { key: "b", origin: { kind: "local" }, reportedCwd: "", spawnCwd: "/tmp" },
        { key: "c", origin: { kind: "ssh", target: { host: "web1;echo", user: null, port: null } } },
        { key: "d", origin: { kind: "serial" }, consoleConfig: serialConfig({ password: "nope" } as ConsoleConfig) },
        { key: "e", origin: { kind: "ssh", target: { host: "web1", user: "alice", port: 2222 } } },
        { key: "f", origin: { kind: "serial" }, consoleConfig: serialConfig() },
      ],
      activeKey: "e",
      split,
    });
    assert.equal(file.tabs.some((tab) => tab.kind === "ssh" && tab.host === "web1"), true);
    assert.deepEqual(file.tabs[0], { kind: "local", cwd: null });
    assert.equal(file.active, 1);
    assert.equal(file.split, null);
  });

  it("restores local shells only, remaps a split, and treats an empty or foreign file as no restore", () => {
    const file = {
      version: 1,
      active: 2,
      split: { orientation: "right", index: [1, 2], focus: 1 },
      tabs: [
        { kind: "ssh", host: "web1", user: "alice", port: 2222 },
        { kind: "local", cwd: "relative" },
        { kind: "local", cwd: "/work" },
        { kind: "serial", config: serialConfig() },
      ],
    };
    const localPlan = restorePlan(file, "local");
    assert.deepEqual(localPlan, {
      tabs: [
        { kind: "local", cwd: null, ssh: null, config: null, title: "shell" },
        { kind: "local", cwd: "/work", ssh: null, config: null, title: "shell" },
      ],
      active: 1,
      split: { orientation: "right", index: [0, 1], focus: 1 },
    });
    const remote = restorePlan(file, "reconnect");
    assert.equal(remote?.tabs[0].title, "ssh alice@web1");
    assert.equal(remote?.tabs[3].title, "tty.usb · 9600 · prod");
    assert.deepEqual(remote?.split, { orientation: "right", index: [1, 2], focus: 1 });
    assert.equal(restorePlan({ ...file, tabs: [] }, "reconnect"), null);
    assert.equal(restorePlan({ ...file, version: 2 }, "reconnect"), null);
    assert.equal(restorePlan(file, "off"), null);
    assert.equal(restorePlan({ version: 1, active: 0, split: null, tabs: [{ kind: "ssh", host: "web1", user: null, port: null }] }, "local"), null);
  });

  it("drops a split whose pane did not survive and caps the saved list", () => {
    const tabs = [local("a"), { key: "b", origin: { kind: "sah" } as const }, local("c", "/other")];
    const file = snapshotWorkspace({
      tabs,
      activeKey: "missing",
      split: { orientation: "right", keys: ["a", "b"], focus: 1 },
    });
    assert.equal(file.split, null);
    assert.equal(file.active, 0);
    const wide = snapshotWorkspace({
      tabs: Array.from({ length: 40 }, (_, index) => local(`t${index}`, `/d${index}`)),
      activeKey: "t39",
      split: null,
    });
    assert.equal(wide.tabs.length, 32);
    assert.equal(wide.active, 0);
    const shifted = restorePlan({
      version: 1,
      active: 0,
      split: { orientation: "down", index: [1, 2], focus: 0 },
      tabs: [
        { kind: "ssh", host: "web1", user: null, port: null },
        { kind: "local", cwd: "/a" },
        { kind: "local", cwd: "/b" },
      ],
    }, "local");
    assert.deepEqual(shifted?.split, { orientation: "down", index: [0, 1], focus: 0 });
  });
});
