export type Action =
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "copy"
  | "paste"
  | "find"
  | "prefs"
  | "clear"
  | "fontLarger"
  | "fontSmaller"
  | "interrupt"
  | "explain";

export type Bindings = Record<Action, string>;

export const DEFAULT_BINDINGS: Bindings = {
  newTab: "Mod+T",
  closeTab: "Mod+W",
  nextTab: "Mod+Shift+]",
  prevTab: "Mod+Shift+[",
  copy: "Mod+C",
  paste: "Mod+V",
  find: "Mod+F",
  prefs: "Mod+,",
  clear: "Mod+K",
  fontLarger: "Mod+=",
  fontSmaller: "Mod+-",
  interrupt: "Ctrl+Shift+C",
  explain: "Mod+Shift+E",
};

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function chordMatches(chord: string, event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const needMod = parts.includes("Mod");
  const needCtrl = parts.includes("Ctrl") || (needMod && !isMac());
  const needMeta = parts.includes("Meta") || (needMod && isMac());
  const needAlt = parts.includes("Alt");
  const needShift = parts.includes("Shift");

  if (Boolean(event.ctrlKey) !== needCtrl) return false;
  if (Boolean(event.metaKey) !== needMeta) return false;
  if (Boolean(event.altKey) !== needAlt) return false;
  if (Boolean(event.shiftKey) !== needShift) return false;

  const pressed = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const expected = key.length === 1 ? key.toUpperCase() : key;
  if (expected === "=" && (pressed === "=" || pressed === "+")) return true;
  return pressed === expected;
}

export function matchAction(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, bindings: Bindings = DEFAULT_BINDINGS): Action | null {
  for (const [action, chord] of Object.entries(bindings) as [Action, string][]) {
    if (chordMatches(chord, event)) return action;
  }
  return null;
}
