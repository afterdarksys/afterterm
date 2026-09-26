import assert from "node:assert/strict";
import { it } from "node:test";
import { JUNIPER_PROFILES } from "./juniper.ts";
it("Junos helpers remain operational commands and never change active ports", () => {
  const p = JUNIPER_PROFILES[0];
  assert.ok(p.notes.some((n) => n.includes("reboot")));
  for (const h of p.helpers) { assert.match(h.command, /^set cli screen-length /); assert.equal(h.scope, "session"); }
  assert.ok(!p.helpers.some((h) => /commit|auxiliary|reboot/.test(h.command)));
});
