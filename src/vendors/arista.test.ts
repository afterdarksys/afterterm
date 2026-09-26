import assert from "node:assert/strict";
import { it } from "node:test";
import { ARISTA_PROFILES } from "./arista.ts";
it("Arista explicitly distinguishes Aboot Ctrl+C from electrical BREAK", () => {
  const p = ARISTA_PROFILES[0];
  assert.equal(p.settings.baud, 9600);
  assert.match(p.recovery, /Ctrl\+C \(ASCII 3\)/);
  assert.match(p.recovery, /BREAK is not/);
  assert.ok(!p.helpers.some((h) => /boot console/.test(h.command)));
});
