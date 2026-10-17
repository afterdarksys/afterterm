/** One row of the xterm buffer: its text and whether it continues the previous row. */
export type BufferLine = { text: string; wrapped: boolean };

const ESCAPES = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC ... BEL or ST
    "\\u001b[P^_X][^\\u001b]*\\u001b\\\\", // DCS, PM, APC, SOS ... ST
    "\\u009b[0-?]*[ -/]*[@-~]", // 8-bit CSI
    "\\u001b\\[[0-?]*[ -/]*[@-~]", // CSI
    "\\u001b[ -/]*[0-~]", // other two-byte and charset escapes
  ].join("|"),
  "g",
);

/** Remove terminal escape sequences and control characters, keeping text, tabs and newlines. */
export function stripEscapes(raw: string): string {
  return raw
    .replace(ESCAPES, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Join wrapped rows, trim trailing spaces and blank tail rows, and return plain text. */
export function linesToText(lines: BufferLine[]): string {
  const logical: string[] = [];
  for (const line of lines) {
    if (line.wrapped && logical.length) logical[logical.length - 1] += line.text;
    else logical.push(line.text);
  }
  const cleaned = logical.map((line) => stripEscapes(line).replace(/\s+$/, ""));
  while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop();
  return cleaned.length ? `${cleaned.join("\n")}\n` : "";
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** A standalone, script-free HTML document containing the transcript as preformatted text. */
export function transcriptHtml(text: string, title: string, when: Date): string {
  const heading = `${title} transcript, ${when.toISOString()}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(heading)}</title>`,
    "<style>body{font-family:ui-monospace,Menlo,monospace;margin:2rem}pre{white-space:pre-wrap;word-break:break-word}</style>",
    "</head><body>",
    `<h1>${escapeHtml(heading)}</h1>`,
    `<pre>${escapeHtml(stripEscapes(text))}</pre>`,
    "</body></html>",
    "",
  ].join("\n");
}

/** A safe default file name: letters, digits, dot, dash and underscore only. */
export function transcriptFileName(title: string, extension: string, when: Date): string {
  const base = title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60) || "session";
  const stamp = when.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-${stamp}.${extension}`;
}
