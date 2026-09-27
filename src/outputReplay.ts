export type Chunk = { sequence: number; data: number[] | Uint8Array };
export type Snapshot = { chunks: Chunk[]; sequence: number; dropped: number; exit: number | null; reviewed: boolean; pending: import("./ConfirmDialog.tsx").Challenge | null };
/** Merge a snapshot taken after event subscription with events received during IPC. */
export class OutputReplay {
  private ready = false;
  private last = 0;
  private queued: Chunk[] = [];
  private bytes = 0;
  private dropped = false;
  constructor(private write: (data: Uint8Array) => void, private notice: (text: string) => void) {}
  receive(chunk: Chunk) {
    if (!this.ready) {
      this.queued.push(chunk); this.bytes += chunk.data.length;
      while (this.bytes > 256 * 1024) { this.bytes -= this.queued.shift()!.data.length; this.dropped = true; }
      return;
    }
    this.emit(chunk);
  }
  attach(snapshot: Snapshot) {
    if (this.ready) return;
    if (snapshot.dropped) this.notice(`${snapshot.dropped} bytes of early output dropped`);
    // The first retained sequence may be >1 when bounded history overflowed.
    this.last = snapshot.chunks[0]?.sequence ? snapshot.chunks[0].sequence - 1 : snapshot.sequence;
    for (const chunk of snapshot.chunks) this.emit(chunk);
    this.last = Math.max(this.last, snapshot.sequence);
    this.ready = true;
    if (this.dropped) this.notice("Output arrived faster than attachment could consume it; some live output may be missing");
    for (const chunk of this.queued.sort((a, b) => a.sequence - b.sequence)) this.emit(chunk);
    this.queued = []; this.bytes = 0;
  }
  private emit(chunk: Chunk) {
    if (chunk.sequence <= this.last) return;
    if (chunk.sequence !== this.last + 1) this.notice("Terminal output gap detected");
    this.last = chunk.sequence; this.write(Uint8Array.from(chunk.data));
  }
}
