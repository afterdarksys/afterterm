import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { acceleratorToChord, chordMatches, DEFAULT_BINDINGS, MENU_ACTIONS, matchAction, type Action } from "./keybindings.ts";

const isMacPlatform = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function event(partial: Partial<KeyboardEvent>): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code"> {
  return {
    key: "t",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: "",
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

describe("keybindings and the menu bar agree", () => {
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const items = new Map<string, string | null>();
  for (const match of lib.matchAll(/item\(\s*handle,\s*"([^"]+)",\s*"[^"]*",\s*(?:Some\("([^"]+)"\)|None)\s*,?\s*\)/g)) {
    items.set(match[1], match[2] ?? null);
  }

  it("gives every keybinding a menu item with the same accelerator", () => {
    const covered = new Set(Object.values(MENU_ACTIONS));
    for (const action of Object.keys(DEFAULT_BINDINGS) as Action[]) assert.ok(covered.has(action), `${action} has no menu item`);
    for (const [id, action] of Object.entries(MENU_ACTIONS)) {
      assert.ok(items.has(id), `menu item ${id} is missing from install_menu`);
      const accelerator = items.get(id);
      assert.ok(accelerator, `menu item ${id} has no accelerator`);
      assert.equal(acceleratorToChord(accelerator), DEFAULT_BINDINGS[action], id);
    }
  });

  it("never binds one chord to two actions", () => {
    const chords = Object.values(DEFAULT_BINDINGS);
    assert.equal(new Set(chords).size, chords.length);
    const accelerators = [...items.values()].filter(Boolean);
    assert.equal(new Set(accelerators).size, accelerators.length);
  });

  it("matches Option and Shift chords by physical key", () => {
    assert.equal(matchAction(event({ key: "ß", code: "KeyS", metaKey: true, altKey: true })), isMacPlatform() ? "exportHtml" : null);
    assert.equal(chordMatches("Mod+Shift+]", event({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true })), isMacPlatform());
  });

  it("routes the new edit and file actions", () => {
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    assert.equal(matchAction(event({ key: "x", ...mod })), "cut");
    assert.equal(matchAction(event({ key: "s", ...mod })), "saveTranscript");
    assert.equal(matchAction(event({ key: "p", ...mod })), "print");
    assert.equal(matchAction(event({ key: "i", ...mod })), "sessionInfo");
  });
});
