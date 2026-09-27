# AfterTerm engineering and product audit

Date: 2026-09-27. Audited revision: `92e4a94bbcb9f2fd7d87e32e20380cea5bf94086`.

## Follow-up implementation

See [RELIABILITY-VERIFICATION.md](RELIABILITY-VERIFICATION.md) for the changes and
regression evidence addressing AT-01 through AT-07. The findings below preserve
the original audited revision. Target detection was replaced with explicit unknown
state and conservative submission review; automatic shell/remote target discovery
is still deferred. The complete M0 platform/performance qualification is not claimed.

## Verdict

AfterTerm is an early native terminal with useful infrastructure tooling. It is not yet an agentic development environment. Keep the PTY, serial transport, vendor profiles, and optional-AI principle. Address the input, context, and lifecycle defects below before building autonomous execution on top.

The proposed product objective is to replace Cursor and Antigravity for developers who also operate infrastructure. The accompanying enhancement plan treats this as an AfterTerm pivot. No AfterEdit integration or source changes were made. The existing AGENTS.md and PRODUCT-DIRECTION.md still describe the earlier standalone-terminal scope; they should be reconciled with the chosen product direction before implementation.

## Method and limits

- Inspected React terminal/session lifecycle, clipboard, production confirmation, Rust PTY/context/classification, serial I/O/paste/reconnect, preferences, SSH queries, tests and packaging configuration.
- Consulted the required code graph first; its architecture response contained no communities, so source inspection supplied the evidence.
- Findings distinguish source-confirmed behavior from timing scenarios that still require end-to-end reproduction. Severity is relative to the stated product contract; the current command detector is not a security sandbox.
- No real production commands, remote connections, physical console changes, or provider requests were executed.
- Native GUI behavior, macOS accessibility, Linux, physical adapters, sustained-output performance, signing/notarization and complete dependency/security analysis remain unqualified. This is a bounded engineering/product audit, not a security certification.

## Validation

| Check | Result |
| --- | --- |
| `npm test` | 22 passed, 0 failed |
| `./node_modules/.bin/tsc --noEmit` | Passed |
| `vite build --outDir /private/tmp/afterterm-audit-dist` | Passed; JS bundle 671.66 kB, 180.75 kB gzip; chunk-size warning |
| `cargo test --workspace --locked --offline --target-dir /private/tmp/afterterm-audit-target` | 42 passed (7 desktop/backend + 35 PTY/core); 0 failed, 0 ignored |
| Compiled-library audit probe with fake local CLI tools | Reproduced AT-01 for Tab/cursor/bracketed-paste and AT-02 for explicit `--context prod` |

The first Vite attempt was blocked by the session sandbox when writing its temporary config under AfterTerm; the approved rerun passed. This was an environment restriction, not an application failure. Tests use a temporary Cargo target directory to avoid altering the existing app build.

## Findings

### AT-01 — P1: common editing paths bypass production review

Evidence: `crates/afterterm-pty/src/gate.rs:62`, `:68`, `:96`; existing tests at `:340` and `:351` explicitly expect Enter to pass after arrows or Tab.

ESC sequences, Tab and several control bytes set `desynced`. Enter is held only when that flag is false. Thus typing a destructive command and moving the cursor, completing it with Tab, or recalling it from shell history bypasses the detector. Bracketed-paste escape sequences also desynchronize it. The source documents this behavior, but AGENTS.md promises unreviewed production Enter is not submitted.

Impact: ordinary shell usage invalidates the visible production-protection promise. Do not reuse this heuristic as authorization for agents or remote control.

Fix: define explicit observed, unknown and protected command states. Use shell integration for supported shells to obtain the actual command and context, while treating shell-provided metadata as untrusted for agent authorization. Protected unknown submissions must require review or be refused. Full-screen applications need a separate transparent terminal mode with an explicit protection state, not an ambiguous parser fallback.

Regression gate: history, Tab, cursor edits, bracketed paste, multiline commands, aliases and unsupported shell states cannot silently cross a claimed protected submission boundary. Verify vim/tmux/k9s compatibility separately.

Evidence level: confirmed by implementation, executed existing tests and a standalone probe linked against the actual compiled `afterterm-pty` library. The probe fed Tab, cursor-left and bracketed-paste-start after a destructive line and asserted that Enter returned `Step::Pass`. No real destructive command was executed.

### AT-02 — P1: confirmation can use the wrong target or treat failed detection as safe

Evidence: `crates/afterterm-pty/src/destructive.rs:114`, `crates/afterterm-pty/src/context.rs:91`, `:132`, `crates/afterterm-pty/src/session.rs:226`.

`challenge_for_task` classifies the arguments, then gathers context without using their target flags. `kubectl --context prod delete ...` can be evaluated against the app's default development context. Terraform uses the spawn directory even after the shell changes directory. Shell-local AWS_PROFILE/KUBECONFIG exports do not update the parent application's environment. `target()` also prioritizes any Kubernetes context over a Terraform workspace or AWS profile, even when another field caused the production flag. Probe failures become empty fields and can yield no challenge, after which the held newline is released.

Impact: a protected-looking command can run against production without the right confirmation, or ask the user to confirm an unrelated environment.

Fix: command-specific target resolution with explicit flags, session environment and current directory; provenance and freshness in each result. Keep unknown distinct from development. Remote identity needs a remote-aware mechanism, not local guesses. Bind approval to the command, resolved target, session and request generation; invalidate it if these change.

Regression gate: default dev plus `--context prod`; `--kubeconfig`; AWS `--profile`; `cd` into production Terraform workspace; probe timeout; shell-local environment changes; conflicting Kubernetes/AWS/Terraform names. Use fake tools and disposable environments.

Evidence level: reproduced against the compiled library with fake local `kubectl`, `aws`, `terraform` and `tofu` executables returning `dev`. With AWS_PROFILE=dev, `challenge_for_line(None, "kubectl --context prod delete pod audit-fixture")` returned `None`. The command was only parsed, never submitted. Other target scenarios remain source findings requiring integration tests.

### AT-03 — P1: shortcut paste skips terminal paste semantics and can change destination

Evidence: `src/TerminalPane.tsx:95`, `src/App.tsx:251`. Installed xterm implementation: `node_modules/@xterm/xterm/src/browser/Clipboard.ts:51`.

The shortcut reads the clipboard and calls the pane's `paste`, which sends raw text through `write`. It does not call xterm's `Terminal.paste`, which normalizes newlines and wraps text when bracketed paste is enabled. Multiline clipboard text can therefore be submitted as commands instead of being inserted as one editable paste. The asynchronous clipboard callback also resolves the active pane after the read completes; changing tabs in that interval can redirect the paste.

Fix: capture the intended session at the start, verify it is still alive, and use xterm's paste API for PTYs. Keep explicit reviewed serial paste. Coordinate this with AT-01 so adding bracketed-paste markers does not silently bypass protection.

Regression gate: multiline paste stays in the shell edit buffer when bracketed paste is enabled; CR/LF normalization matches native paste; switching or closing tabs during clipboard permission/read cannot send to another session.

Evidence level: source-confirmed; native clipboard/shell reproduction still required.

### AT-04 — P2: initial PTY output and exit can precede renderer attachment

Evidence: `crates/afterterm-pty/src/session.rs:153`, `src-tauri/src/lib.rs:40`, `src/App.tsx:66`, `src/TerminalPane.tsx:162`, `:207`.

The shell and output reader start before spawn returns. The React pane mounts after the ID is received, then waits for layout before subscribing. Output is emitted immediately without a PTY attach/replay protocol. A fast startup prompt, banner or exit can arrive before that pane listens. Serial already has a bounded boot buffer and explicit attach command.

Fix: add PTY attach with bounded ordered replay, terminal dimensions and a retained exit state. Preserve ordering between buffered and live output; make overflow explicit. Backpressure must prevent a stalled renderer from consuming unbounded memory.

Regression gate: delay attachment while a child immediately writes and exits; observe each byte and final exit exactly once. Exercise overflow and renderer reattachment.

Evidence level: confirmed race window in source; native timing reproduction still required.

### AT-05 — P2: closing a starting tab can orphan its shell

Evidence: `src/App.tsx:62`, `:66`, `:187`.

Close only kills sessions with an assigned ID. If the tab closes while `pty_spawn` is pending, the returned ID is mapped over a tab list that no longer contains the key. The process remains in the backend without an owning tab. The serial reconnect path already checks tab existence after open and closes late results.

Fix: session creation needs a request generation and ownership check. Kill any successful late spawn whose tab was removed/replaced; release bookkeeping on both success and failure.

Regression gate: defer spawn, close the tab, then resolve spawn; assert the returned session is killed exactly once and other tabs remain alive.

Evidence level: source-confirmed interleaving; no UI test currently covers it.

### AT-06 — P2: environment badge can be stale or belong to another tab

Evidence: `src/App.tsx:117` through the context-loading effect.

Context loads only when the selected session ID/transport changes. There is no response-generation check. A slow response for tab A can replace tab B's context, including after moving to a serial tab. Changes within an active shell do not trigger a refresh.

Fix: store context per session and reject stale responses. Refresh from shell/transport context events and show unknown or stale status until verified. This UI correction complements AT-02; it does not fix backend target resolution by itself.

Regression gate: resolve A after B; switch to serial before A resolves; change context inside the active shell. The badge must never assert the previous target as the current one.

Evidence level: source-confirmed asynchronous-state defect.

### AT-07 — P2: failed confirmation dismisses the only recovery UI

Evidence: `src/App.tsx:331` and `:336`; pending state in `crates/afterterm-pty/src/session.rs:261` and `src-tauri/src/serial.rs:126`.

Confirm/cancel starts IPC and immediately clears the dialog. If delivery fails before the backend consumes pending state, the user loses the review UI while input remains held. Serial rejects further input while pending; PTY queues it. A single global challenge slot also allows another session's challenge to replace an unresolved one.

Fix: await an acknowledged state transition, disable duplicate submissions, retain retry/cancel on transport error, and represent pending requests per session with unique IDs. Reconcile with backend state after reconnect or ambiguous delivery instead of blindly retrying a potentially completed action.

Regression gate: injected IPC failure, duplicate click, two sessions requesting review, session closing during review, and success followed by a lost reply. No double submission or unreachable pending request.

Evidence level: source-confirmed error path; transport failure injection still required.

## Additional work to measure, not asserted as reproduced defects

- PTY writes occur while holding the global session mutex. Measure whether a blocked child can stall unrelated tabs and move blocking I/O to per-session workers if confirmed.
- Context probes are sequential and can each wait seconds; `pty_context` is a synchronous Tauri command. Measure UI responsiveness and move bounded probing off the UI-sensitive path.
- Preferences use direct `fs::write`; add atomic replacement and ordered saves before persisting important workspace/agent state.
- Modal components declare dialog semantics but lack a complete focus-management test suite. Test focus trapping, restoration, keyboard-only operation and VoiceOver.
- Linux release script selects the macOS `app` bundle target. Qualify platform-specific packaging before advertising downloadable Linux builds.
- Current tests cover helpers and backend units, not mounted React session/IPC workflows. The AI tests verify a deliberately unavailable provider; they are not agent capability evidence.

## Capability inventory

| Capability | Current evidence | Gap to the target |
| --- | --- | --- |
| Local terminal | Native PTY, xterm, tabs, search, themes | Attach reliability, paste, splits, recovery, performance qualification |
| Infrastructure access | Native serial, paced paste, vendor notes, USB identity matching | Hardware matrix; durable connection profiles; typed SSH/container/cluster sessions |
| Production review | Heuristic PTY line tracker; explicit serial review | Actual target identity, protected unknown state, durable approvals |
| AI | `src/ai.ts` always returns an unavailable/off/empty-selection result | Provider integration, tools, streaming, orchestration, budgets, evaluation |
| Code workspace | No integrated editor/workspace service in inspected app | File search/edit, LSP, Git diffs, conflict handling, checkpoints |
| Agent delivery | No implemented agent task lifecycle | Plan/edit/test/review workflow, interruption, crash recovery, verified results |
| Browser verification | No browser agent in current app | Isolated browser execution, evidence, permission boundaries |
| Team/enterprise | Product roadmap only | Identity, policy, audit, signed releases and administrative controls |

## Implementation order

AT-01/02/03 are blockers for production-protection claims and agent execution. Resolve AT-04/05/06/07 in the same reliability milestone. Add meaningful React/IPC and native PTY regression coverage as part of each fix. Then deliver the first end-to-end agent workflow described in PRODUCT-ENHANCEMENT-PLAN.md.
