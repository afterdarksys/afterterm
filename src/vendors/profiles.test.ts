import assert from "node:assert/strict";
import { it } from "node:test";
import { VENDOR_PROFILES } from "./index.ts";
import { applyProfile } from "./types.ts";
import { DEFAULT_CONSOLE } from "../console.ts";
it("vendor profiles have unique ids, documented scope, and preserve session identity and review", () => {
  assert.equal(new Set(VENDOR_PROFILES.map((p) => p.id)).size, VENDOR_PROFILES.length);
  for (const profile of VENDOR_PROFILES) {
    assert.ok(profile.appliesTo && profile.recovery && profile.sources.length);
    assert.ok(profile.sources.every((s) => s.url.startsWith("https://")));
    const config = applyProfile({ ...DEFAULT_CONSOLE, path: "/dev/test", identity: "usb:test", production: true }, profile);
    assert.equal(config.path, "/dev/test");
    assert.equal(config.identity, "usb:test");
    assert.equal(config.production, true);
    for (const helper of profile.helpers) {
      assert.ok(helper.scope === "session" || helper.scope === "device");
      assert.ok(helper.description && helper.command.endsWith("\n"));
    }
  }
});
