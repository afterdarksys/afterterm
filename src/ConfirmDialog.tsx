export type Challenge = {
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
};

export function ConfirmDialog({ challenge, typed, onTyped, onConfirm, onCancel }: Props) {
  const ok = typed.trim() === challenge.expected;
  return (
    <div className="confirm-scrim" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <form
        className="confirm-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (ok) onConfirm();
        }}
      >
        <p className="confirm-kicker">Production command</p>
        <h2 id="confirm-title">{challenge.action}</h2>
        <p>{challenge.reason}. Type the context name to send Enter, or cancel to send Ctrl+C.</p>
        <input
          autoFocus
          value={typed}
          onChange={(event) => onTyped(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label="Type the production context name"
        />
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!ok} className="danger">
            Run
          </button>
        </div>
      </form>
    </div>
  );
}
