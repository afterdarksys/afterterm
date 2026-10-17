export type Tri = "unchanged" | "on" | "off";
export type SttyForm = {
  echo: Tri;
  icanon: Tri;
  isig: Tri;
  ixon: Tri;
  erase: string;
  intr: string;
  eof: string;
};

export const EMPTY_STTY: SttyForm = { echo: "unchanged", icanon: "unchanged", isig: "unchanged", ixon: "unchanged", erase: "", intr: "", eof: "" };

export const STTY_FLAGS = [
  ["echo", "Echo typed characters (echo)"],
  ["icanon", "Line editing, input sent a line at a time (icanon)"],
  ["isig", "Signal keys such as Control-C and Control-Z (isig)"],
  ["ixon", "Flow control with Control-S and Control-Q (ixon)"],
] as const;

export const STTY_CHARS = [
  ["erase", "Erase character"],
  ["intr", "Interrupt character"],
  ["eof", "End of file character"],
] as const;

/** Caret notation (^C, ^?, ^\) or the word undef; empty means unchanged. */
export function normalizeControlChar(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (/^undef$/i.test(trimmed)) return "undef";
  const match = /^\^([A-Za-z@[\\\]^_?])$/.exec(trimmed);
  return match ? `^${match[1].toUpperCase()}` : null;
}

export type SttyResult = { command: string } | { error: string } | { command: null };

/** Compose one stty command from the form; arguments are single-quoted so no shell expands them. */
export function composeStty(form: SttyForm): SttyResult {
  const args: string[] = [];
  for (const [flag] of STTY_FLAGS) {
    if (form[flag] === "on") args.push(flag);
    if (form[flag] === "off") args.push(`-${flag}`);
  }
  for (const [name, label] of STTY_CHARS) {
    const value = normalizeControlChar(form[name]);
    if (value === null) return { error: `${label} must be caret notation such as ^C, ^H or ^?, or the word undef` };
    if (value) args.push(name, `'${value}'`);
  }
  if (!args.length) return { command: null };
  return { command: `stty ${args.join(" ")}` };
}
