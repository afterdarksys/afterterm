import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyBlockEvent, BLOCK_CAP, commandText, EMPTY_BLOCKS, formatDuration, INTEGRATION_SNIPPET,
  isCommandBlock, oscAction, unescapeCommand, type BlockEvent, type BlockRecord,
} from "./blocks.ts";
import { BlockStore, type TermLike } from "./blockMarkers.ts";

function ids() {
  let n = 0;
  return () => {
    n += 1;
    return `b${n}`;
  };
}

function run(events: BlockEvent[], now = 1_000): BlockRecord[] {
  const nextId = ids();
  return events.reduce((blocks, event, index) => applyBlockEvent(blocks, event, now + index, nextId), [] as BlockRecord[]);
}

describe("block events", () => {
  it("records a command from E then C then D then A", () => {
    const blocks = run([
      { kind: "prompt" },
      { kind: "command", text: "ls" },
      { kind: "executed" },
      { kind: "finished", exitCode: 0 },
      { kind: "prompt" },
    ]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].status, "finished");
    assert.equal(blocks[0].command, "ls");
    assert.equal(blocks[0].commandReported, true);
    assert.equal(blocks[0].exitCode, 0);
    assert.equal(blocks[1].status, "prompt");
    assert.equal(commandText(blocks[0]), "ls");
    assert.equal(isCommandBlock(blocks[0]), true);
    assert.equal(isCommandBlock(blocks[1]), false);
  });

  it("does not stack prompts and ignores a leading D", () => {
    const same = applyBlockEvent([], { kind: "unknown" }, 1, ids());
    assert.equal(same, same);
    const first = applyBlockEvent([], { kind: "prompt" }, 1, ids());
    const again = applyBlockEvent(first, { kind: "prompt" }, 2, ids());
    assert.equal(again, first);
    const ignored = applyBlockEvent([], { kind: "finished", exitCode: 0 }, 1, ids());
    assert.equal(ignored.length, 0);
    assert.equal(applyBlockEvent(ignored, { kind: "finished", exitCode: 0 }, 2, ids()), ignored);
  });

  it("closes a running block on A without an exit code", () => {
    const blocks = run([{ kind: "executed" }, { kind: "prompt" }]);
    assert.equal(blocks[0].status, "finished");
    assert.equal(blocks[0].exitCode, null);
    assert.equal(blocks[0].commandReported, false);
    assert.equal(commandText(blocks[0]), "Command text was not reported.");
    assert.equal(blocks[1].status, "prompt");
  });

  it("B opens a prompt only when one is not already open", () => {
    const opened = run([{ kind: "command-start" }]);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].status, "prompt");
    assert.equal(applyBlockEvent(opened, { kind: "command-start" }, 5, ids()), opened);
    const running = run([{ kind: "executed" }]);
    assert.equal(applyBlockEvent(running, { kind: "command-start" }, 5, ids()), running);
  });

  it("unescapes semicolon, backslash and newline, and drops unsafe text", () => {
    assert.equal(unescapeCommand("a\\x3bb"), "a;b");
    assert.equal(unescapeCommand("a\\\\b"), "a\\b");
    assert.equal(unescapeCommand("a\\nb"), "a\nb");
    assert.equal(unescapeCommand(""), "");
    assert.equal(unescapeCommand("a\\"), null);
    assert.equal(unescapeCommand("a\\q"), null);
    assert.equal(unescapeCommand("a\u0007"), null);
    assert.equal(unescapeCommand("a\u001b"), null);
    assert.equal(unescapeCommand("a\u009c"), null);
    assert.equal(unescapeCommand("a\u007f"), null);
    assert.equal(unescapeCommand("ok\t"), "ok\t");
    assert.equal(unescapeCommand("x".repeat(4097)), null);
    const dropped = run([{ kind: "command", text: "a;b" }]);
    assert.equal(dropped[0].command, "");
    assert.equal(dropped[0].commandReported, false);
    const kept = run([{ kind: "command", text: "a\\x3bb" }]);
    assert.equal(kept[0].command, "a;b");
    assert.equal(kept[0].commandReported, true);
    assert.equal(isCommandBlock(kept[0]), true);
  });

  it("parses exit codes and OSC payloads", () => {
    assert.deepEqual(oscAction(false, 133, "A"), { consume: false, event: null });
    assert.deepEqual(oscAction(true, 133, "A"), { consume: true, event: { kind: "prompt" } });
    assert.deepEqual(oscAction(true, 633, "C"), { consume: true, event: { kind: "executed" } });
    assert.deepEqual(oscAction(true, 133, "D;0"), { consume: true, event: { kind: "finished", exitCode: 0 } });
    assert.deepEqual(oscAction(true, 133, "D;000"), { consume: true, event: { kind: "finished", exitCode: 0 } });
    assert.deepEqual(oscAction(true, 133, "D;1000"), { consume: true, event: { kind: "finished", exitCode: null } });
    assert.deepEqual(oscAction(true, 133, "D"), { consume: true, event: { kind: "finished", exitCode: null } });
    assert.deepEqual(oscAction(true, 133, "D;no"), { consume: true, event: { kind: "finished", exitCode: null } });
    assert.equal(oscAction(true, 133, "B").event?.kind, "command-start");
    assert.equal(oscAction(true, 633, "B").event?.kind, "unknown");
    assert.equal(oscAction(true, 133, "E;ls").event?.kind, "unknown");
    assert.deepEqual(oscAction(true, 633, "E;ls"), { consume: true, event: { kind: "command", text: "ls" } });
    assert.equal(oscAction(true, 133, "Z").consume, true);
    assert.equal(oscAction(true, 7, "A").consume, false);
    const same = [] as BlockRecord[];
    assert.equal(applyBlockEvent(same, { kind: "unknown" }, 1, ids()), same);
  });

  it("records D on a prompt that already has a command and ignores D on a finished block", () => {
    const prompted = run([{ kind: "command", text: "pwd" }]);
    const finished = applyBlockEvent(prompted, { kind: "finished", exitCode: 2 }, 9, ids());
    assert.equal(finished[0].status, "finished");
    assert.equal(finished[0].exitCode, 2);
    assert.equal(applyBlockEvent(finished, { kind: "finished", exitCode: 1 }, 10, ids()), finished);
  });

  it("caps the history and keeps issuing new ids", () => {
    let blocks: BlockRecord[] = [];
    const nextId = ids();
    for (let i = 0; i < BLOCK_CAP + 5; i += 1) {
      blocks = applyBlockEvent(blocks, { kind: "executed" }, i, nextId);
      blocks = applyBlockEvent(blocks, { kind: "prompt" }, i, nextId);
    }
    assert.equal(blocks.length, BLOCK_CAP);
    assert.equal(blocks[0].id, "b7");
    assert.notEqual(blocks.at(-1)?.id, "b1");
  });

  it("formats durations and keeps the snippet honest", () => {
    assert.equal(formatDuration(999), "999 ms");
    assert.equal(formatDuration(1000), "1.0 s");
    assert.equal(formatDuration(1500), "1.5 s");
    assert.equal(formatDuration(-4), "0 ms");
    assert.ok(INTEGRATION_SNIPPET.includes("\\x3b"));
    assert.ok(INTEGRATION_SNIPPET.includes("133"));
    assert.ok(INTEGRATION_SNIPPET.includes("633"));
    assert.ok(EMPTY_BLOCKS.includes("OSC 133"));
  });
});

describe("block markers", () => {
  function fakeTerm() {
    let line = 10;
    const disposed: string[] = [];
    const term: TermLike = {
      registerMarker() {
        const marker = { line, dispose: () => { disposed.push(`m${marker.line}`); marker.line = -1; } };
        line += 1;
        return marker;
      },
      registerDecoration(options) {
        return { dispose: () => disposed.push(options.overviewRulerOptions?.color ?? "decoration") };
      },
      scrollToLine() {},
      buffer: {
        active: {
          viewportY: 0,
          cursorY: 4,
          getLine(index: number) {
            if (index < 0) return undefined;
            return { translateToString: () => `line-${index}` };
          },
        },
      },
    };
    return { term, disposed };
  }

  it("selects command blocks, copies output, and drops markers on clear", () => {
    const { term, disposed } = fakeTerm();
    const published: string[] = [];
    const store = new BlockStore(term, (blocks, selected) => {
      published.push(`${blocks.map((block) => block.id).join(",")}:${selected ?? ""}`);
    });
    assert.equal(store.handle(false, true, 133, "A"), false);
    assert.equal(published.length, 0);
    assert.equal(store.handle(true, true, 633, "E;ls"), true);
    assert.equal(store.handle(true, true, 133, "C"), true);
    assert.equal(store.handle(true, true, 133, "D;0"), true);
    store.selectBlock(1);
    assert.equal(store.blockText("command"), "ls");
    const output = store.blockText("output");
    assert.match(output, /line-/);
    assert.equal(store.blockText("block").startsWith("ls\n"), true);
    store.clearBlocks();
    assert.equal(store.blocks().length, 0);
    assert.ok(disposed.length > 0);
    store.handle(true, true, 133, "C");
    assert.equal(store.blocks()[0].id, "b2");
  });
});
