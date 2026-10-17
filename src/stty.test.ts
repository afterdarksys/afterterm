import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeStty, EMPTY_STTY, normalizeControlChar } from "./stty.ts";

describe("stty composition", () => {
  it("sends nothing when nothing changed", () => {
    assert.deepEqual(composeStty(EMPTY_STTY), { command: null });
  });

  it("composes one command with flags and quoted control characters", () => {
    const result = composeStty({ ...EMPTY_STTY, echo: "off", icanon: "on", ixon: "off", erase: "^h", intr: "^C", eof: "undef" });
    assert.deepEqual(result, { command: "stty -echo icanon -ixon erase '^H' intr '^C' eof 'undef'" });
  });

  it("accepts caret punctuation such as ^? and ^\\", () => {
    assert.equal(normalizeControlChar("^?"), "^?");
    assert.equal(normalizeControlChar("^\\"), "^\\");
  });

  it("rejects anything that could become shell syntax", () => {
    for (const bad of ["'", "^C; rm -rf /", "$(id)", "`id`", "^'", "ab", "^1"]) {
      assert.equal(normalizeControlChar(bad), null, bad);
      assert.ok("error" in composeStty({ ...EMPTY_STTY, erase: bad }), bad);
    }
  });
});
