import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainSelection } from "./ai.ts";

describe("ai layer", () => {
  it("does not require a provider when disabled", async () => {
    const result = await explainSelection("ls -la", false);
    assert.equal(result.ok, false);
    assert.match(result.reason, /AI is off/);
  });

  it("asks for a selection instead of calling a model", async () => {
    const result = await explainSelection("   ", true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Select/);
  });

  it("fails closed when enabled without a provider", async () => {
    const result = await explainSelection("kubectl delete", true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /No AI provider/);
  });
});
