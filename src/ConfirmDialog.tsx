import { useEffect, useRef } from "react";
export type Challenge = {
  request_id: number;
  input?: string | null;
  action: string;
  expected: string;
  reason: string;
};

type Props = {
  challenge: Challenge;
  typed: string;
  onTyped: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string;
};

export function ConfirmDialog({ challenge, typed, onTyped, onConfirm, onCancel, busy = false, error = "" }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    formRef.current?.querySelector("input")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const ok = typed.trim() === challenge.expected;
  return (
    <div className="confirm-scrim" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <form
        ref={formRef}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const elements = Array.from(formRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? []);
          const first = elements[0], last = elements[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        className="confirm-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (ok && !busy) onConfirm();
        }}
      >
        <p className="confirm-kicker">Submission review</p>
        <h2 id="confirm-title">{challenge.action}</h2>
        <p>{challenge.reason}. Type <strong>{challenge.expected}</strong> to approve, or cancel.</p>
        {challenge.input && <><p>Held input (control characters escaped; earlier typing may already be visible in the terminal):</p><pre className="submission-preview">{challenge.input}</pre></>}
        {error && <p role="alert">{error}</p>}
        <input
          disabled={busy}
          autoFocus
          value={typed}
          onChange={(event) => onTyped(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label="Confirmation text"
        />
        <div className="confirm-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!ok || busy} className="danger">
            {busy ? "Waiting…" : "Approve"}
          </button>
        </div>
      </form>
    </div>
  );
}
