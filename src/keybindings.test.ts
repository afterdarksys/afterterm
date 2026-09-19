import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chordMatches, matchAction } from "./keybindings.ts";

function event(partial: Partial<KeyboardEvent>): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return {
    key: "t",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("keybindings", () => {
  it("matches Ctrl+Shift+C as interrupt regardless of platform Mod", () => {
    assert.equal(
      matchAction(event({ key: "c", ctrlKey: true, shiftKey: true })),
      "interrupt",
    );
  });

  it("does not treat a lone C as copy", () => {
    assert.equal(matchAction(event({ key: "c" })), null);
  });

  it("accepts Mod+= or Mod++ for font increase", () => {
    assert.equal(chordMatches("Mod+=", event({ key: "=", metaKey: true })), true);
    assert.equal(chordMatches("Mod+=", event({ key: "+", metaKey: true })), true);
  });

  it("requires shift when the chord says Shift", () => {
    assert.equal(chordMatches("Mod+Shift+]", event({ key: "]", metaKey: true })), false);
    assert.equal(chordMatches("Mod+Shift+]", event({ key: "]", metaKey: true, shiftKey: true })), true);
  });
});
