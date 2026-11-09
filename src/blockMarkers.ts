import {
  applyBlockEvent, commandText, isCommandBlock, oscAction, type BlockRecord,
} from "./blocks.ts";

export type MarkerLike = { line: number; dispose: () => void };
export type DecorationLike = { dispose: () => void };

export type TermLike = {
  registerMarker: (cursorYOffset?: number) => MarkerLike | undefined;
  registerDecoration: (options: {
    marker: MarkerLike;
    overviewRulerOptions?: { color: string; position?: "left" | "center" | "right" | "full" };
  }) => DecorationLike | undefined;
  scrollToLine: (line: number) => void;
  buffer: {
    active: {
      viewportY: number;
      cursorY: number;
      getLine: (index: number) => { translateToString: (trimRight?: boolean, startIndex?: number) => string } | undefined | null;
    };
  };
};

type Live = {
  record: BlockRecord;
  start: MarkerLike | null;
  end: MarkerLike | null;
  decoration: DecorationLike | null;
};

function colorFor(record: BlockRecord): string {
  if (record.status !== "finished" || record.exitCode == null) return "#d6a21e";
  return record.exitCode === 0 ? "#3faf6c" : "#d4533c";
}

/** Markers stay with the terminal pane. Ids continue across clear. */
export class BlockStore {
  private records: BlockRecord[] = [];
  private live = new Map<string, Live>();
  private selectedId: string | null = null;
  private seq = 0;
  private enabled = false;
  private gutter = false;

  constructor(
    private term: TermLike,
    private onChange: (blocks: BlockRecord[], selectedId: string | null) => void,
  ) {}

  handle(enabled: boolean, gutter: boolean, code: number, data: string): boolean {
    this.enabled = enabled;
    this.gutter = gutter;
    const action = oscAction(enabled, code, data);
    if (!action.consume || !action.event) return false;
    if (action.event.kind === "unknown") return true;
    const next = applyBlockEvent(this.records, action.event, Date.now(), () => {
      this.seq += 1;
      return `b${this.seq}`;
    });
    if (next === this.records) return true;
    this.commit(next);
    return true;
  }

  clearBlocks(): void {
    for (const live of this.live.values()) this.disposeLive(live);
    this.live.clear();
    this.records = [];
    this.selectedId = null;
    this.publish();
  }

  refreshGutter(enabled = this.enabled, gutter = this.gutter): void {
    this.enabled = enabled;
    this.gutter = gutter;
    for (const live of this.live.values()) this.paint(live);
  }

  blocks(): BlockRecord[] {
    return this.records.map((block) => ({ ...block }));
  }

  selected(): string | null {
    return this.selectedId;
  }

  selectBlock(delta: number): void {
    const indexes = this.records.flatMap((block, index) => (isCommandBlock(block) ? [index] : []));
    if (indexes.length === 0) return;
    const current = this.selectedId == null ? -1 : this.records.findIndex((block) => block.id === this.selectedId);
    const pos = indexes.indexOf(current);
    const nextPos = pos === -1
      ? (delta > 0 ? 0 : indexes.length - 1)
      : (pos + (delta >= 0 ? 1 : -1) + indexes.length) % indexes.length;
    this.selectBlockIndex(indexes[nextPos]);
  }

  selectBlockId(id: string): void {
    const index = this.records.findIndex((block) => block.id === id);
    if (index < 0) return;
    this.selectBlockIndex(index);
  }

  selectBlockIndex(index: number): void {
    const record = this.records[index];
    if (!record) return;
    this.selectedId = record.id;
    const start = this.live.get(record.id)?.start;
    if (start && start.line >= 0) this.term.scrollToLine(start.line);
    this.publish();
  }

  blockText(part: "command" | "output" | "block"): string {
    if (!this.selectedId) return "";
    const live = this.live.get(this.selectedId);
    if (!live) return "";
    const command = commandText(live.record);
    if (part === "command") return command;
    const output = this.outputText(live);
    if (part === "output") return output;
    return `${command}\n${output}`;
  }

  private outputText(live: Live): string {
    if (!live.start || live.start.line < 0) return "Output was not captured.";
    const cursor = this.term.buffer.active.viewportY + this.term.buffer.active.cursorY;
    const endLine = live.end && live.end.line >= 0 ? live.end.line : cursor;
    const lines: string[] = [];
    for (let index = live.start.line + 1; index <= endLine; index += 1) {
      const line = this.term.buffer.active.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  }

  private commit(next: BlockRecord[]): void {
    const ids = new Set(next.map((block) => block.id));
    for (const [id, live] of this.live) {
      if (ids.has(id)) continue;
      this.disposeLive(live);
      this.live.delete(id);
      if (this.selectedId === id) this.selectedId = null;
    }
    for (const record of next) {
      const existing = this.live.get(record.id);
      const previous = existing?.record.status;
      const live = existing ?? { record, start: null, end: null, decoration: null };
      const becameRunning = record.status === "running" && previous !== "running";
      const becameFinished = record.status === "finished" && previous !== "finished";
      live.record = record;
      if (!existing) this.live.set(record.id, live);
      if (becameRunning && !live.start) live.start = this.term.registerMarker(0) ?? null;
      if (becameFinished && !live.end) live.end = this.term.registerMarker(0) ?? null;
      this.paint(live);
    }
    this.records = next;
    this.publish();
  }

  private paint(live: Live): void {
    live.decoration?.dispose();
    live.decoration = null;
    if (!this.enabled || !this.gutter || !live.start) return;
    live.decoration = this.term.registerDecoration({
      marker: live.start,
      overviewRulerOptions: { color: colorFor(live.record), position: "right" },
    }) ?? null;
  }

  private disposeLive(live: Live): void {
    live.decoration?.dispose();
    live.start?.dispose();
    live.end?.dispose();
    live.decoration = null;
    live.start = null;
    live.end = null;
  }

  private publish(): void {
    this.onChange(this.records.map((block) => ({ ...block })), this.selectedId);
  }
}
