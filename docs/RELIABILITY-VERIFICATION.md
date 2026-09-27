# AfterTerm reliability changes — 2026-09-27

Baseline: `92e4a94bbcb9f2fd7d87e32e20380cea5bf94086`.

This change addresses the seven findings in [the audit](AFTERTERM-AUDIT-2026-09-27.md).
It implements the first reliability slice of the enhancement plan. It does not
complete every M0 platform, hardware, performance or supported-shell qualification.

## Behavior

New PTY sessions use reviewed submissions. Every CR/LF packet is held until
approved; shell history, cursor movement, Tab, aliases and incomplete escape
sequences cannot cause an unreviewed newline to pass. The entire held packet is
shown with control characters escaped. Approval releases that packet, which may
include multiple pasted lines. Earlier typing may already be at the shell.
Typing while a review is pending returns an error rather than silently extending
the approved packet. Cancel discards the packet and sends Ctrl+C; if a bracketed
paste prefix was previously sent, cancellation closes it before the interrupt.

Choose **Use direct terminal** and type `DIRECT` for unrestricted interactive
work, including vim/tmux/k9s. Review is explicitly off until enabled again.
This is an intentional conservative replacement for the unreliable heuristic;
it adds review friction and is not automatic production-command classification.
It is not a security boundary for agents, remote control or arbitrary shell code.

Explicit target arguments can be displayed as unverified hints. Missing,
ambiguous or edited command information remains **unknown target**. The backend
never authorizes a submission using the GUI process's AWS/Kubernetes environment
or original working directory. The old potentially stale environment badge was
removed; the footer reports unknown target and the selected session's review mode.
Supported-shell integration and verified remote identity are still future work.

Review requests are bound to transport, session and monotonically increasing
request ID. Duplicate or delayed acknowledgements cannot release newer input.
The UI queues reviews, waits for acknowledgement, retains retry/cancel on delivery
failure, and reconciles ambiguous responses with backend pending state. A write
error with potentially partial output is surfaced as an uncertain outcome and
is not automatically replayed. Changing mode also reconciles lost replies, so
an uncertain mode change cannot leave the UI falsely claiming review is enabled.

PTY output has a bounded 256 KiB sequenced history and retained exit state.
Renderer attachment merges the snapshot and concurrent events without duplicates;
overflow/gaps are visible. On Unix the reader owns a close-on-exec descriptor and
retains the slave while draining a finished child, preventing the short-lived
child output loss found on macOS. Exit is reported after drained output.

Sessions have separate I/O locks. A blocked writer does not hold the session-map
lock or block another terminal's write. A late spawn whose tab was closed is
killed. Clipboard reads capture their original session and use xterm's paste API;
switching tabs cannot redirect a paste, and closing its destination cancels it.

## Regression mapping

| Finding | Implementation | Evidence |
| --- | --- | --- |
| AT-01 | Every CR/LF held in reviewed mode; explicit direct mode | Rust gate tests cover Tab, history, cursor edits, partial escape, aliases, blank input and multiline packets; native PTY held-input test |
| AT-02 | Command-specific explicit hints; unknown default; no environment probes in review | Rust cases for explicit context/profile, kubeconfig, duplicate flags, expansions, compound commands and Terraform unknown target |
| AT-03 | xterm bracketed paste; captured destination and liveness check | Browser tests assert exact escaped bytes and original session; close-during-read test |
| AT-04 | Sequenced bounded history and exit snapshot; Unix drain lifecycle | 1,000 actual `/bin/echo` sessions with delayed attachment; pure replay ordering/overflow tests; real xterm scrollback integration |
| AT-05 | Synchronous tab ownership plus late-spawn cleanup | Browser test resolves spawn after tab close and verifies exactly the orphan session is killed |
| AT-06 | Remove unverified global context; show per-session review state and unknown target | Browser tab-switch test; lost mode-change reply reconciliation test |
| AT-07 | Session/request IDs, queued review, acknowledged transitions and reconciliation | Rust PTY/serial duplicate/stale/wrong-answer tests; browser failure/retry, lost acknowledgement, queue and delayed-event tests |

## Checks

Tests were run from an isolated staging copy because this session's writable
workspace was AfterEdit. The validated files are copied to AfterTerm with
pre-copy conflict checks and post-copy hash verification.

- `npm test`: **24 passed**.
- `npm run test:integration`: **10 passed**.
- `npm run build`: **Passed** (TypeScript and Vite production frontend build).
- `cargo test --workspace --locked --offline --target-dir /private/tmp/afterterm-audit-target`:
  **43 passed** (7 desktop/serial + 36 PTY/core; 0 failed, 0 ignored).
- Rust checks include 1,000 real short-lived PTY sessions and a synthetic blocked
  writer proving another native session can still accept input.
- Browser tests use Chromium at `/Applications/Chromium.app/Contents/MacOS/Chromium`
  with the actual React/xterm interface and controlled mocked native IPC. They
  do not replace packaged Tauri UI qualification.

Run browser checks with `npm run test:integration`; install Playwright Chromium
or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. The lockfile includes the new test dependency.
The pre-existing Vite chunk-size warning remains; it is not a correctness failure.

## Still required before broader release claims

- Supported-shell command/current-directory/environment integration and verified
  SSH/cluster/account identity; current unknown-target review is the explicit fallback.
- Native packaged macOS GUI testing, full-screen tool exercises, keyboard/VoiceOver
  qualification, Linux execution and packaging, and physical serial adapter tests.
- Sustained-output and large-paste performance/backpressure measurements. History
  and attachment queues are bounded; this does not establish a bound on every
  WebView/xterm rendering queue under unlimited live output.
- Throughput, latency and resource budgets from the enhancement plan; real terminal
  pause/stop behavior when the current session's own writer is blocked.
- No new app has been installed in `/Applications` by this change. No commit or
  push is implied by passing the checks.
