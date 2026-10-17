import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { acceleratorToChord, chordMatches, DEFAULT_BINDINGS, MENU_ACTIONS, matchAction, OTHER_BINDINGS, platformBindings, terminalHandlesKey, type Action, type Bindings } from "./keybindings.ts";

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
  it("matches Ctrl+Shift+C as interrupt on macOS and as copy elsewhere", () => {
    const press = event({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    assert.equal(matchAction(press, DEFAULT_BINDINGS), "interrupt");
    assert.equal(matchAction(press, OTHER_BINDINGS), "copy");
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
  // OTHER_ACCELERATORS: the accelerator registered off macOS, keyed by the macOS one.
  const table = /const OTHER_ACCELERATORS[^=]*=\s*&\[([\s\S]*?)\];/.exec(lib)?.[1] ?? "";
  const other = new Map([...table.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [m[1], m[2]] as const));

  it("gives every keybinding a menu item with the same accelerator on macOS and elsewhere", () => {
    const covered = new Set(Object.values(MENU_ACTIONS));
    for (const action of Object.keys(DEFAULT_BINDINGS) as Action[]) assert.ok(covered.has(action), `${action} has no menu item`);
    assert.ok(other.size > 0, "OTHER_ACCELERATORS was not found in lib.rs");
    for (const [id, action] of Object.entries(MENU_ACTIONS)) {
      assert.ok(items.has(id), `menu item ${id} is missing from install_menu`);
      const accelerator = items.get(id);
      assert.ok(accelerator, `menu item ${id} has no accelerator`);
      assert.equal(acceleratorToChord(accelerator), DEFAULT_BINDINGS[action], id);
      const elsewhere = other.get(accelerator);
      assert.ok(elsewhere, `${accelerator} (${id}) has no OTHER_ACCELERATORS entry`);
      assert.equal(acceleratorToChord(elsewhere), OTHER_BINDINGS[action], `${id} off macOS`);
    }
  });

  it("never binds one chord to two actions", () => {
    for (const bindings of [DEFAULT_BINDINGS, OTHER_BINDINGS]) {
      const chords = Object.values(bindings);
      assert.equal(new Set(chords).size, chords.length);
    }
    const accelerators = [...items.values()].filter(Boolean);
    assert.equal(new Set(accelerators).size, accelerators.length);
    assert.equal(new Set(other.values()).size, other.size);
  });

  it("leaves Control+letter to the shell off macOS", () => {
    for (const chord of Object.values(OTHER_BINDINGS)) {
      const parts = chord.split("+");
      const key = parts[parts.length - 1];
      assert.ok(!parts.includes("Mod"), `${chord} must name Ctrl explicitly`);
      if (/^[A-Z]$/.test(key)) assert.ok(parts.includes("Shift"), `${chord} would take Control+${key} from the shell`);
    }
    for (const key of "ACDEPRSUWZ") {
      const press = event({ key: key.toLowerCase(), code: `Key${key}`, ctrlKey: true });
      assert.equal(matchAction(press, OTHER_BINDINGS), null, `Ctrl+${key}`);
      assert.equal(terminalHandlesKey(press, OTHER_BINDINGS), true, `Ctrl+${key}`);
    }
  });

  it("matches Option and Shift chords by physical key", () => {
    assert.equal(matchAction(event({ key: "ß", code: "KeyS", metaKey: true, altKey: true })), isMacPlatform() ? "exportHtml" : null);
    assert.equal(chordMatches("Mod+Shift+]", event({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true })), isMacPlatform());
  });

  it("routes the new edit and file actions on each platform", () => {
    const mac = { metaKey: true };
    assert.equal(matchAction(event({ key: "x", ...mac }), DEFAULT_BINDINGS), "cut");
    assert.equal(matchAction(event({ key: "s", ...mac }), DEFAULT_BINDINGS), "saveTranscript");
    assert.equal(matchAction(event({ key: "p", ...mac }), DEFAULT_BINDINGS), "print");
    assert.equal(matchAction(event({ key: "i", ...mac }), DEFAULT_BINDINGS), "sessionInfo");
    // OTHER_BINDINGS name Ctrl explicitly, so they match the same way on every platform.
    const linux = { ctrlKey: true, shiftKey: true };
    assert.equal(matchAction(event({ key: "X", code: "KeyX", ...linux }), OTHER_BINDINGS), "cut");
    assert.equal(matchAction(event({ key: "S", code: "KeyS", ...linux }), OTHER_BINDINGS), "saveTranscript");
    assert.equal(matchAction(event({ key: "S", code: "KeyS", altKey: true, ...linux }), OTHER_BINDINGS), "saveSelection");
    assert.equal(matchAction(event({ key: "P", code: "KeyP", ...linux }), OTHER_BINDINGS), "print");
  });

  it("uses the table for the running platform", () => {
    assert.equal(platformBindings(true), DEFAULT_BINDINGS);
    assert.equal(platformBindings(false), OTHER_BINDINGS);
  });
});

describe("Send Control-C reaches the session exactly once", () => {
  // The two keydown handlers in the order the browser runs them: xterm's (on its textarea) and
  // the app's (on window). xterm turns Control+letter into a control character and, when it
  // does, cancels the event so the app never sees it; otherwise the event bubbles to the app.
  function deliver(press: ReturnType<typeof event>, bindings: Bindings): string[] {
    const sent: string[] = [];
    let consumed = false;
    if (terminalHandlesKey(press, bindings) && press.ctrlKey && !press.metaKey && !press.altKey && /^Key[A-Z]$/.test(press.code)) {
      sent.push(String.fromCharCode(press.code.charCodeAt(3) - 64)); // what xterm would send
      consumed = true;
    }
    if (!consumed && matchAction(press, bindings) === "interrupt") sent.push("\u0003");
    return sent;
  }

  it("does not let xterm translate an app chord, so the app sends the one Control-C", () => {
    const press = event({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    assert.equal(terminalHandlesKey(press, DEFAULT_BINDINGS), false);
    assert.deepEqual(deliver(press, DEFAULT_BINDINGS), ["\u0003"]);
  });

  it("lets xterm send a plain Control-C and the app stays out of it", () => {
    const press = event({ key: "c", code: "KeyC", ctrlKey: true });
    // Mod is Control when these tests run off macOS, so DEFAULT_BINDINGS only applies on a Mac.
    for (const bindings of isMacPlatform() ? [DEFAULT_BINDINGS, OTHER_BINDINGS] : [OTHER_BINDINGS]) {
      assert.equal(terminalHandlesKey(press, bindings), true);
      assert.deepEqual(deliver(press, bindings), ["\u0003"]);
    }
  });

  it("sends no Control-C from Control+Shift+C off macOS, where it is Copy", () => {
    const press = event({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    assert.equal(matchAction(press, OTHER_BINDINGS), "copy");
    assert.deepEqual(deliver(press, OTHER_BINDINGS), []);
  });
});
