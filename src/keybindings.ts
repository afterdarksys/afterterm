export type Action =
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "clearSelection"
  | "find"
  | "prefs"
  | "clear"
  | "resetTerminal"
  | "fontLarger"
  | "fontSmaller"
  | "fontReset"
  | "interrupt"
  | "explain"
  | "saveTranscript"
  | "saveSelection"
  | "exportHtml"
  | "print"
  | "logSession"
  | "sessionInfo"
  | "toggleReview"
  | "connectSah"
  | "connectConsole"
  | "sshCompat";

export type Bindings = Record<Action, string>;

export const DEFAULT_BINDINGS: Bindings = {
  newTab: "Mod+T",
  closeTab: "Mod+W",
  nextTab: "Mod+Shift+]",
  prevTab: "Mod+Shift+[",
  copy: "Mod+C",
  cut: "Mod+X",
  paste: "Mod+V",
  selectAll: "Mod+A",
  clearSelection: "Mod+Shift+A",
  find: "Mod+F",
  prefs: "Mod+,",
  clear: "Mod+K",
  resetTerminal: "Mod+Alt+R",
  fontLarger: "Mod+=",
  fontSmaller: "Mod+-",
  fontReset: "Mod+0",
  interrupt: "Ctrl+Shift+C",
  explain: "Mod+Shift+E",
  saveTranscript: "Mod+S",
  saveSelection: "Mod+Shift+S",
  exportHtml: "Mod+Alt+S",
  print: "Mod+P",
  logSession: "Mod+Shift+L",
  sessionInfo: "Mod+I",
  toggleReview: "Mod+Shift+R",
  connectSah: "Mod+Shift+H",
  connectConsole: "Mod+Shift+O",
  sshCompat: "Mod+Shift+K",
};

/** Menu item ids (src-tauri/src/lib.rs install_menu) that run the same action as a keybinding. */
export const MENU_ACTIONS: Record<string, Action> = {
  "file.new-tab": "newTab",
  "file.close-tab": "closeTab",
  "file.save-transcript": "saveTranscript",
  "file.save-selection": "saveSelection",
  "file.export-html": "exportHtml",
  "file.log-session": "logSession",
  "file.print": "print",
  "app.prefs": "prefs",
  "edit.copy": "copy",
  "edit.cut": "cut",
  "edit.paste": "paste",
  "edit.select-all": "selectAll",
  "edit.clear-selection": "clearSelection",
  "edit.find": "find",
  "edit.explain": "explain",
  "shell.clear": "clear",
  "shell.reset": "resetTerminal",
  "shell.interrupt": "interrupt",
  "shell.toggle-review": "toggleReview",
  "shell.connect-sah": "connectSah",
  "shell.connect-console": "connectConsole",
  "shell.ssh-compat": "sshCompat",
  "view.session-info": "sessionInfo",
  "view.font-larger": "fontLarger",
  "view.font-smaller": "fontSmaller",
  "view.font-reset": "fontReset",
  "window.next-tab": "nextTab",
  "window.prev-tab": "prevTab",
};

type KeyEventLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { code?: string };

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

// Option and Shift change event.key on macOS (Option+S is "ß", Shift+] is "}"), so
// fall back to the physical key for letters, digits and the punctuation we bind.
const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Equal: "=", Minus: "-", Comma: ",", Period: ".", Slash: "/",
};
function codeKey(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_KEYS[code] ?? null;
}

export function chordMatches(chord: string, event: KeyEventLike): boolean {
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
  if (pressed === expected) return true;
  return codeKey(event.code) === expected;
}

export function matchAction(event: KeyEventLike, bindings: Bindings = DEFAULT_BINDINGS): Action | null {
  for (const [action, chord] of Object.entries(bindings) as [Action, string][]) {
    if (chordMatches(chord, event)) return action;
  }
  return null;
}

/** Convert a Tauri menu accelerator ("CmdOrCtrl+Shift+S") to binding notation ("Mod+Shift+S"). */
export function acceleratorToChord(accelerator: string): string {
  return accelerator.split("+").map((part) => (part === "CmdOrCtrl" || part === "CommandOrControl" ? "Mod" : part)).join("+");
}
