import assert from "node:assert/strict";
import { it } from "node:test";
import { FORTINET_PROFILES } from "./fortinet.ts";
it("Fortinet preserves family baud differences and labels persistent paging changes", () => {
  const gate = FORTINET_PROFILES.find((p) => p.id === "fortinet-fortigate")!;
  assert.equal(gate.settings.baud, 9600);
  assert.ok(gate.helpers.length > 0 && gate.helpers.every((h) => h.scope === "device"));
  for (const p of FORTINET_PROFILES.filter((p) => p !== gate)) {
    assert.equal(p.settings.baud, 115200);
    assert.equal(p.helpers.length, 0);
  }
});
