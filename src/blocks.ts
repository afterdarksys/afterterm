/** Warp-style command blocks parsed from OSC 133 and OSC 633. The terminal stays a real PTY. */

export type BlockStatus = "prompt" | "running" | "finished";

export type BlockRecord = {
  id: string;
  command: string;
  commandReported: boolean;
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  status: BlockStatus;
};

export type BlockEvent =
  | { kind: "prompt" }
  | { kind: "command-start" }
  | { kind: "command"; text: string }
  | { kind: "executed" }
  | { kind: "finished"; exitCode: number | null }
  | { kind: "unknown" };

export const BLOCK_CAP = 200;
export const MAX_COMMAND = 4096;

export const EMPTY_BLOCKS =
  "No command blocks yet. Blocks appear when the shell reports OSC 133 or OSC 633 markers. Enable shell integration for new local zsh or bash tabs, or copy the snippet for other shells. Command text is not reported until a marker includes it.";

/** Copyable fallback for shells AfterTerm does not inject. The semicolon escape is the four characters \\x3b. */
export const INTEGRATION_SNIPPET = [
  "# AfterTerm shell integration. Print these markers at the prompt, never from inside a full-screen program such as vim.",
  "# OSC 133 A  prompt ready",
  "# OSC 133 C  command started",
  "# OSC 133 D  command finished; the first field is the exit code",
  "# OSC 633 E  command text; encode a semicolon as the four characters \\x3b",
  "printf '\\033]133;A\\007'",
  "printf '\\033]633;E;%s\\007' \"$(printf '%s' \"$cmd\" | sed 's/;/\\\\x3b/g')\"",
  "printf '\\033]133;C\\007'",
  "printf '\\033]133;D;%s\\007' \"$status\"",
].join("\n");

const UNREPORTED = "Command text was not reported.";

export function commandText(block: BlockRecord): string {
  return block.commandReported ? block.command : UNREPORTED;
}

/** A bare prompt with no command text is not a command block. */
export function isCommandBlock(block: BlockRecord): boolean {
  return block.status !== "prompt" || block.commandReported || block.command.length > 0;
}

export function formatDuration(ms: number): string {
  const elapsed = Math.max(0, ms);
  if (elapsed < 1000) return `${Math.floor(elapsed)} ms`;
  return `${(elapsed / 1000).toFixed(1)} s`;
}

function prompt(id: string): BlockRecord {
  return {
    id,
    command: "",
    commandReported: false,
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    status: "prompt",
  };
}

function cap(blocks: BlockRecord[]): BlockRecord[] {
  return blocks.length > BLOCK_CAP ? blocks.slice(blocks.length - BLOCK_CAP) : blocks;
}

/** null means the command text is dropped. */
export function unescapeCommand(raw: string): string | null {
  if (raw.length > MAX_COMMAND) return null;
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === ";") return null;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) return null;
    if (next === "\\") {
      out += "\\";
      i += 1;
      continue;
    }
    if (next === "n") {
      out += "\n";
      i += 1;
      continue;
    }
    if (raw.slice(i + 1, i + 4) === "x3b") {
      out += ";";
      i += 3;
      continue;
    }
    return null;
  }
  if (out.length > MAX_COMMAND) return null;
  for (const char of out) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return null;
  }
  return out;
}

export function applyBlockEvent(
  blocks: BlockRecord[],
  event: BlockEvent,
  now: number,
  nextId: () => string,
): BlockRecord[] {
  if (event.kind === "unknown") return blocks;
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;

  if (event.kind === "prompt") {
    if (last?.status === "prompt") return blocks;
    const next = blocks.slice();
    if (last?.status === "running") {
      next[next.length - 1] = { ...last, status: "finished", finishedAt: now };
    }
    next.push(prompt(nextId()));
    return cap(next);
  }

  if (event.kind === "command-start") {
    if (last?.status === "prompt" || last?.status === "running") return blocks;
    const next = blocks.slice();
    next.push(prompt(nextId()));
    return cap(next);
  }

  if (event.kind === "command") {
    const parsed = unescapeCommand(event.text);
    const next = blocks.slice();
    let index = next.length - 1;
    if (!last || last.status === "finished") {
      next.push(prompt(nextId()));
      index = next.length - 1;
    } else {
      next[index] = { ...last };
    }
    const target = next[index];
    if (parsed === null) {
      target.command = "";
      target.commandReported = false;
    } else {
      target.command = parsed;
      target.commandReported = true;
    }
    return cap(next);
  }

  if (event.kind === "executed") {
    const next = blocks.slice();
    if (!last || last.status === "finished") {
      const created = prompt(nextId());
      created.status = "running";
      created.startedAt = now;
      next.push(created);
      return cap(next);
    }
    if (last.status === "running" && last.startedAt != null) return blocks;
    next[next.length - 1] = {
      ...last,
      status: "running",
      startedAt: last.startedAt ?? now,
    };
    return cap(next);
  }

  if (event.kind === "finished") {
    if (!last || last.status === "finished") return blocks;
    const hasCommand = last.commandReported || last.command.length > 0;
    if (last.status === "prompt" && !hasCommand) return blocks;
    const next = blocks.slice();
    next[next.length - 1] = {
      ...last,
      status: "finished",
      finishedAt: now,
      exitCode: event.exitCode,
    };
    return cap(next);
  }

  return blocks;
}

function exitCode(segment: string): number | null {
  return /^\d{1,3}$/.test(segment) ? Number(segment) : null;
}

/** OSC handler result. `data` is the payload after `OSC ident ;`. */
export function oscAction(
  enabled: boolean,
  code: number,
  data: string,
): { consume: boolean; event: BlockEvent | null } {
  if (!enabled) return { consume: false, event: null };
  if (code !== 133 && code !== 633) return { consume: false, event: null };
  const split = data.indexOf(";");
  const marker = split === -1 ? data : data.slice(0, split);
  const rest = split === -1 ? "" : data.slice(split + 1);
  if (marker === "A") return { consume: true, event: { kind: "prompt" } };
  if (marker === "C") return { consume: true, event: { kind: "executed" } };
  if (marker === "D") return { consume: true, event: { kind: "finished", exitCode: exitCode(rest.split(";")[0] ?? "") } };
  if (code === 133 && marker === "B") return { consume: true, event: { kind: "command-start" } };
  if (code === 633 && marker === "E") return { consume: true, event: { kind: "command", text: rest } };
  return { consume: true, event: { kind: "unknown" } };
}
