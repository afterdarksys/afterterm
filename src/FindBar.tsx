type Props = {
  query: string;
  onQuery: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
};

export function FindBar({ query, onQuery, onNext, onPrev, onClose }: Props) {
  return (
    <form
      className="findbar"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <input
        autoFocus
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="Find in scrollback"
        aria-label="Find in scrollback"
      />
      <button type="button" onClick={onPrev} aria-label="Previous match">
        ↑
      </button>
      <button type="submit" aria-label="Next match">
        ↓
      </button>
      <button type="button" onClick={onClose} aria-label="Close find">
        Done
      </button>
    </form>
  );
}
