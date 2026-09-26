import assert from "node:assert/strict";
import { it } from "node:test";
import { CISCO_PROFILES } from "./cisco.ts";
it("Cisco recovery differentiates BREAK and Ctrl+C without embedding recovery commands", () => {
  const p = CISCO_PROFILES[0];
  assert.match(p.recovery, /real serial BREAK/);
  assert.ok(p.notes.some((n) => n.includes("precedence")));
  assert.deepEqual(p.helpers.map((h) => h.command), ["terminal length 0\n", "terminal length 24\n"]);
});
