import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PREFS, fromWire, toWire } from "./prefs.ts";

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
