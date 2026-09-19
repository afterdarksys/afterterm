import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme, THEME_IDS, withAlpha } from "./themes.ts";

describe("themes", () => {
  it("falls back to signal for unknown ids", () => {
    assert.equal(resolveTheme("nope").id, "signal");
    assert.equal(resolveTheme("afterdark").id, "afterdark");
  });

  it("every theme has a terminal foreground and chrome accent", () => {
    for (const id of THEME_IDS) {
      const theme = resolveTheme(id);
      assert.ok(theme.terminal.foreground);
      assert.ok(theme.chrome.accent);
    }
  });

  it("clamps transparency into the background alpha", () => {
    const themed = withAlpha({ background: "#000000", foreground: "#fff" }, 2);
    assert.equal(themed.background, "rgba(0, 0, 0, 1)");
    const faded = withAlpha({ background: "rgba(7, 8, 10, 0.35)", foreground: "#fff" }, 0.5);
    assert.equal(faded.background, "rgba(7, 8, 10, 0.5)");
  });
});
