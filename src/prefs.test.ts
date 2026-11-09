import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PREFS, fromWire, normalizeEndpoint, toWire } from "./prefs.ts";

describe("prefs wire format", () => {
  it("round-trips snake_case for the Rust side", () => {
    const wire = toWire(DEFAULT_PREFS);
    assert.equal(wire.font_family, DEFAULT_PREFS.fontFamily);
    assert.equal(wire.ai_enabled, false);
    const back = fromWire(wire);
    assert.deepEqual(back, DEFAULT_PREFS);
  });

  it("rejects unknown cursor styles as bar", () => {
    const prefs = fromWire({
      ...toWire(DEFAULT_PREFS),
      cursor_style: "blinky",
    });
    assert.equal(prefs.cursorStyle, "bar");
  });
});

it("loads legacy preferences and preserves separate custom palettes", () => {
  const legacy = toWire(DEFAULT_PREFS);
  delete legacy.theme_overrides;
  assert.deepEqual(fromWire(legacy).themeOverrides, {});
  const prefs = { ...DEFAULT_PREFS, themeOverrides: {
    signal: { terminal: { red: "#123456" } },
    paper: { chrome: { accent: "#654321" } },
  } };
  assert.deepEqual(fromWire(toWire(prefs)), prefs);
});

it("defaults the newer preferences when an older file lacks them", () => {
  const wire = toWire(DEFAULT_PREFS);
  for (const key of [
    "line_height", "cursor_blink", "bell_style", "option_as_meta", "copy_on_select", "screen_reader_mode", "review_new_tabs",
    "new_tab_directory", "confirm_close_busy", "open_links", "mark_background_tabs", "notify_system", "restore_sessions", "connections",
  ] as const) delete wire[key];
  assert.deepEqual(fromWire(wire), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.reviewNewTabs, false);
  assert.equal(DEFAULT_PREFS.copyOnSelect, false);
});

it("maps the newer preferences to snake_case and rejects bad values", () => {
  const prefs = { ...DEFAULT_PREFS, bellStyle: "sound" as const, lineHeight: 1.5, optionAsMeta: true, copyOnSelect: true, reviewNewTabs: true, cursorBlink: false };
  const wire = toWire(prefs);
  assert.equal(wire.bell_style, "sound");
  assert.equal(wire.review_new_tabs, true);
  assert.deepEqual(fromWire(wire), prefs);
  const bad = fromWire({ ...wire, bell_style: "klaxon", line_height: 9 });
  assert.equal(bad.bellStyle, "none");
  assert.equal(bad.lineHeight, 1);
});

it("normalizes a Drive endpoint and keeps an explicit port", () => {
  assert.equal(normalizeEndpoint(""), "");
  assert.equal(normalizeEndpoint("https://API.Example.com:443/s3/"), "https://api.example.com:443/s3");
  assert.equal(normalizeEndpoint("http://api.darkstorage.io/s3"), null);
  assert.equal(normalizeEndpoint("https://api.darkstorage.io/s3?x=1"), null);
  assert.equal(normalizeEndpoint("https://api.darkstorage.io/s3\n"), null);
  assert.equal(normalizeEndpoint(" "), null);
});

it("sanitizes Blocks and Drive fields when an older or bad file is loaded", () => {
  const wire = toWire(DEFAULT_PREFS);
  delete wire.blocks_enabled;
  delete wire.drive_region;
  const missing = fromWire(wire);
  assert.equal(missing.blocksEnabled, false);
  assert.equal(missing.driveRegion, "us-east-1");
  const emptyRegion = fromWire({ ...toWire(DEFAULT_PREFS), drive_region: "" });
  assert.equal(emptyRegion.driveRegion, "");
  const bad = fromWire({
    ...toWire(DEFAULT_PREFS),
    drive_endpoint: "http://nope/s3",
    drive_bucket: "../x",
    drive_secret_source: "paste",
    drive_region: "NOT VALID",
  });
  assert.equal(bad.driveEndpoint, "");
  assert.equal(bad.driveBucket, "");
  assert.equal(bad.driveSecretSource, "env");
  assert.equal(bad.driveRegion, "us-east-1");
});
