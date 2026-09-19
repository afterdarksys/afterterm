/** AI is a layer. The emulator works with this module returning an error. */

export type ExplainResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export async function explainSelection(text: string, enabled: boolean): Promise<ExplainResult> {
  const snippet = text.trim();
  if (!snippet) {
    return { ok: false, reason: "Select some terminal text first." };
  }
  if (!enabled) {
    return {
      ok: false,
      reason: "AI is off. AfterTerm still copies, searches, and runs shells without it.",
    };
  }
  return {
    ok: false,
    reason: "No AI provider is configured. The terminal does not depend on one.",
  };
}
