import {
  commandText, EMPTY_BLOCKS, formatDuration, isCommandBlock, type BlockRecord,
} from "./blocks.ts";
import type { Prefs } from "./prefs.ts";
import { usePanel } from "./usePanel.ts";

type Props = {
  prefs: Prefs;
  blocks: BlockRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
};

export function BlocksPanel({ prefs, blocks, selectedId, onSelect, onClose }: Props) {
  const panelRef = usePanel<HTMLElement>(onClose);
  const commands = blocks.filter(isCommandBlock);
  return (
    <aside ref={panelRef} className="prefs blocks" role="dialog" aria-labelledby="blocks-title">
      <header>
        <h2 id="blocks-title" tabIndex={-1}>Blocks</h2>
        <button type="button" onClick={onClose}>Close</button>
      </header>
      {!prefs.blocksEnabled && <p className="prefs-note">Blocks are off</p>}
      {commands.length === 0 ? <p className="prefs-note">{EMPTY_BLOCKS}</p> : (
        <ul className="block-list">
          {commands.map((block) => (
            <li key={block.id}>
              <button
                type="button"
                aria-current={block.id === selectedId}
                onClick={() => onSelect(block.id)}
              >
                <span>{commandText(block)}</span>
                {prefs.blocksShowExit && block.status === "finished" && (
                  <small>{block.exitCode === null ? "exit unknown" : `exit ${block.exitCode}`}</small>
                )}
                {prefs.blocksShowDuration && block.startedAt != null && block.finishedAt != null && (
                  <small>{formatDuration(block.finishedAt - block.startedAt)}</small>
                )}
                {prefs.blocksShowTimestamps && block.startedAt != null && (
                  <small>{new Date(block.startedAt).toLocaleTimeString()}</small>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
