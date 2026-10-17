import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linesToText, stripEscapes, transcriptFileName, transcriptHtml } from "./transcript.ts";

describe("transcript", () => {
  it("strips CSI, OSC, charset and control sequences", () => {
    const raw = "\u001b[1;31mred\u001b[0m \u001b]0;title\u0007ok\u001b(B\u0007\r\nnext\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\";
    assert.equal(stripEscapes(raw), "red ok\nnextlink");
  });

  it("keeps tabs and newlines but drops other C0 controls", () => {
    assert.equal(stripEscapes("a\tb\u0008c\u0000\nd"), "a\tbc\nd");
  });

  it("joins wrapped rows and trims trailing blanks", () => {
    const text = linesToText([
      { text: "$ echo hello   ", wrapped: false },
      { text: "long-", wrapped: false },
      { text: "line", wrapped: true },
      { text: "", wrapped: false },
      { text: "   ", wrapped: false },
    ]);
    assert.equal(text, "$ echo hello\nlong-line\n");
  });

  it("keeps the space at a soft wrap between words", () => {
    assert.equal(linesToText([{ text: "hello ", wrapped: false }, { text: "world", wrapped: true }]), "hello world\n");
  });

  it("returns empty text for an empty buffer", () => {
    assert.equal(linesToText([{ text: "  ", wrapped: false }]), "");
  });

  it("escapes HTML and never emits markup from output", () => {
    const html = transcriptHtml("<script>alert('x')</script> & \u001b[31mred", "a<b", new Date("2026-10-17T00:00:00Z"));
    assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; red"));
    assert.ok(html.includes("a&lt;b transcript"));
    assert.ok(!html.includes("<script>"));
  });

  it("builds file names without path separators", () => {
    const name = transcriptFileName("../../etc/passwd zsh", "txt", new Date("2026-10-17T01:02:03Z"));
    assert.equal(name, "etc-passwd-zsh-2026-10-17-01-02-03.txt");
    assert.equal(transcriptFileName("///", "log", new Date("2026-10-17T01:02:03Z")), "session-2026-10-17-01-02-03.log");
  });
});
