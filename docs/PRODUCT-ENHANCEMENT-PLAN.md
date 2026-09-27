# AfterTerm: product enhancement plan

Date: 2026-09-27. Baseline: `92e4a94bbcb9f2fd7d87e32e20380cea5bf94086`.

## Objective

Make AfterTerm the preferred replacement for Cursor and Antigravity for developers who build software and operate infrastructure. Measure success by completed, reviewed work and repeated voluntary use, rather than a count of AI features.

Working scope: AfterTerm itself becomes a terminal-centered agentic development workbench. This is a proposed pivot from the current terminal-only roadmap. It does not depend on AfterEdit being installed or merge the two applications. Implementation is proceeding with AfterTerm itself as the working scope; the architecture preserves future reuse through service boundaries without requiring the apps to be connected.

Preserve ordinary local shells without an account or working model provider. Preserve native serial access and full-screen terminal tools. The audit is in AFTERTERM-AUDIT-2026-09-27.md; its defects are prerequisites, not optional polish.

## What winning looks like

A developer opens a repository and a terminal, selects a failing test or operational symptom, and asks for a fix. AfterTerm obtains relevant code and environment context, presents a concrete plan, edits in a recoverable workspace, runs the tests, verifies the UI or sandbox service, and offers a reviewed diff with evidence. The developer can intervene, edit, pause, cancel, reject or resume without losing work.

For operational changes, it also identifies the actual destination, distinguishes observations from proposed actions, and requires the appropriate approval for that action and environment. Approval to edit a local file is not approval to deploy it.

Initial audience: application developers, platform/SRE engineers and security/network engineers doing code-heavy operational work. Initial differentiator: one reliable workspace spanning code, terminals and infrastructure evidence. This is a hypothesis to validate with users, not a claim that competitors lack every constituent feature.

## Competitive baseline

Official documentation reviewed on 2026-09-27. Product behavior can change; record installed versions during evaluations.

| Baseline | Documented workflow | Required response |
| --- | --- | --- |
| Cursor Agent | Code search and editing, command execution, browser verification, checkpoints and user steering | Complete repository tasks with reviewable diffs, interruption and recovery |
| Antigravity IDE | Editor/terminal/browser operation, asynchronous agents, completion and structured artifacts | Coherent workbench with evidence tied to each task |
| Antigravity 2.0 | Standalone agent orchestration, tools, subagents, Chrome and artifacts | Durable task management across workspaces without requiring an editor window to stay open |

Sources: [Cursor Agent](https://cursor.com/docs/agent/overview), [Antigravity IDE](https://www.antigravity.google/docs/ide/overview/), [Antigravity 2.0](https://www.antigravity.google/docs/overview).

These sources establish the comparison categories, not a hands-on performance result. No market-superiority claim is justified yet.

## Product principles

1. Working software and verified outcomes outrank chat fluency. Every completion includes the changed files, validation actually run, result and unresolved limits.
2. Human work survives agent activity. Stale patches are rejected; undo never silently overwrites newer user edits.
3. Terminals remain terminals. AI failure, quota exhaustion or an account outage cannot break a local shell.
4. Session and target identity are explicit. Unknown is a visible state, not an alias for development.
5. Review is proportional to effect. Local edits, sandbox execution, network access and production mutations have distinct capabilities.
6. Context and tool output are data. Repository instructions, logs, terminal escape sequences and web pages cannot grant new capabilities.
7. Provider choice is useful only when tested. Start with one working adapter behind a neutral interface; add a second before claiming portability.

## Experience

One window has a workspace/file navigator, a central editor/terminal split area, a task sidebar and a review/evidence view. Keyboard commands move between these surfaces without losing focus. An always-visible task state exposes waiting, running, reviewing, failed, canceled and complete.

The primary actions are Ask, Plan, Implement, Verify and Review. Ask performs permitted reads; Implement works within the granted workspace; Verify runs named checks; Review shows the diff and evidence before acceptance. These are explicit execution policies, not merely alternative prompt text.

The first demo is: reproduce a failing test in a sample service, locate the cause, generate a patch, rerun the test and suite, review the diff, then reject or accept it. A second demo diagnoses a sandbox Kubernetes/Terraform issue and proposes a code change with the actual target shown. Real production deployment is outside the first demo.

## Architecture

Keep transport, workspace state, task orchestration and authorization separate. The current PTY keystroke classifier must not become the agent tool executor.

| Boundary | Responsibility | Initial implementation direction |
| --- | --- | --- |
| Desktop UI | Editor/terminal layout, tasks, approvals, diffs, evidence | React/Tauri; refactor App state into explicit session and task stores |
| Session service | PTY/serial lifecycle, attach/replay, resize, bounded output | Evolve `afterterm-pty` and `serial.rs`; per-session workers and event sequence IDs |
| Workspace service | Canonical paths, buffers, file versions, search, Git, checkpoints | New Rust service; version-checked writes, atomic persistence, symlink-boundary checks |
| Agent runtime | Durable task state, provider streaming, tool loop, cancellation, limits | New runtime crate behind typed IPC; model calls do not directly invoke OS operations |
| Tool broker | Validates inputs and capabilities, executes tasks, records outcomes | Typed argument arrays; bounded output/time; cancellation of owned process trees |
| Policy service | Workspace/host/target grants and request-bound approvals | Explicit identities, scope and expiry; persisted pending state; deny unknown protected mutations |
| Evidence store | Plans, patches, test runs, logs, screenshots and acceptance | Versioned local transactional store; task IDs and workspace revision/hash on each record |
| Verification workers | Tests, browser and sandbox infrastructure checks | Isolated environments and browser profiles with explicit lifecycle and cleanup |
| Provider adapters | Authentication, streaming, tool schemas, usage and errors | Credentials in OS storage; cancel/budget/retry contract tested with deterministic fixtures |

Worktrees isolate repository changes but are not a security sandbox. Agent subprocesses need separately enforced filesystem and network restrictions. Choose and validate the macOS/Linux isolation mechanism in the architecture spike; if isolation is unavailable, refuse protected execution rather than presenting it as sandboxed.

Workspace records should include root identity and buffer/disk versions. Task records should include objective, workspace, run state, provider/model, limits and parent relationship. Tool requests should include typed inputs, target, required capability, deadline and idempotency key. Results should include exit status, actual execution state, evidence references and redaction/truncation markers.

Durability rule: record intent before side effects, record outcome after acknowledgement, and represent an unknown outcome explicitly after a crash. Never automatically replay a possibly completed mutation. Shell/browser output is not an authoritative completion signal.

## Delivery milestones

Estimates below are planning ranges in focused engineer-weeks, not promises or elapsed dates. They include implementation, tests and review; discovery can change them. Roles describe needed expertise and do not assume an available team.

| Milestone | Outcome | Dependencies | Estimate | Owner role |
| --- | --- | --- | --- | --- |
| M0: trustworthy foundation | Reliable terminal, target identity and regression harness | None | 3–5 | Rust/platform + frontend/test |
| M1: development workspace | Edit, navigate, inspect Git and recover human work | M0 session interfaces | 6–10 | Editor/workspace |
| M2: first complete agent | Diagnose → patch → test → review in one repository | M0 + M1 write/checkpoint APIs | 6–10 | Runtime + workspace/test |
| M3: verified delivery | Browser verification, DAP debugging, evidence and isolated background tasks | M2 | 5–8 | Runtime/verification |
| M4: infrastructure advantage | Typed remote targets, runbooks and code-to-environment workflows | M0 target policy + M2/M3 | 5–9 | Infrastructure/security |
| M5: daily-driver beta | Migration, distribution, performance and comparative user evidence | M1–M4 | 4–7 | Product/platform/QA |

Total order of magnitude: 29–49 focused engineer-weeks, with uncertainty highest in editor maturity, OS isolation and cross-platform qualification. Start with an M0/M1 architecture spike and re-estimate from measured throughput. An experienced three-person team can overlap some work, but dividing the total by three ignores dependencies.

### M0 — trustworthy foundation

Deliver AT-01 through AT-07 with regression coverage. Define protected versus ordinary terminal behavior; preserve full-screen tools without pretending to know every shell command. Implement PTY attachment replay and exit recovery, safe paste, spawn ownership, per-session context and acknowledged approvals. Add React/IPC interaction tests and native PTY integration tests.

Exit criteria: zero open P1 findings from this audit; deterministic regression cases for each P2; 1,000 start/attach/exit/close cycles with no lost startup bytes or orphan sessions; synthetic blocked-output tests keep another session usable. Qualify macOS and Linux separately and publish failures rather than averaging them away.

### M1 — development workspace

Add workspace roots, file tree, quick open, search, editor buffers, split layout, language-server integration, diagnostics, formatting and Git status/diff/staging. Integrate a proven editor component after a short compatibility/license/performance spike. Reuse eligible AfterEdit code only through an explicit extraction review and tests; do not assume its features are already present here.

Implement recoverable drafts, external-change handling, versioned patches and crash-safe checkpoints. Preserve dirty/untracked files, symlinks, binary-file boundaries and user edits during rollback. Add project rules with visible provenance. Begin with TypeScript and Rust; validate Python, Go, shell and infrastructure languages in the beta matrix.

Exit criteria: open/edit/search/test/review without another editor; concurrent user edit plus agent patch never loses text; restart preserves unsaved work; rollback refuses conflicts rather than overwriting; keyboard and accessibility checks cover primary flows.

### M2 — first complete agent

Replace the AI stub with streaming provider integration and a durable tool loop. Initial tools: scoped file discovery/read/search, version-checked patch, Git diff, isolated command/test execution and structured user clarification. Enforce time, token, cost and tool-output limits; make cancellation visible and effective. Add inline edits and completion with a latency budget after the patch workflow is reliable.

Use Ask/Plan/Implement/Verify/Review policies. Store plans and task events; support pause, steer, retry and resume. Show the source of retrieved context. Keep secrets out of provider requests by default through explicit excluded paths and selected context; do not claim automatic redaction is perfect. Add a second provider adapter and mocked outage/quota/malformed-tool tests before advertising provider independence.

Exit criteria: the sample-service demo passes end-to-end; provider failure leaves shell/editor usable; only verified checks are labeled passed; stale patches are rejected; cancel stops owned work; restart does not duplicate a side effect. No tool may escape its workspace or inherit production access merely because a model requested it.

### M3 — verified delivery

Add isolated browser interaction and screenshots, test-output linking, DAP launch/attach/breakpoint/stack support, task artifacts and a review inbox. Bind each test/screenshot to the exact revision, environment and run. Run bounded background tasks in separate worktrees with separate terminal/port ownership. Add task dependencies and a reviewer pass; deterministic tests remain the acceptance authority, not an agent's vote.

Enable parallel agents only after single-task durability and process isolation pass. Maintain a global concurrency/resource budget and surface merge conflicts for review. Cleanup must close browsers, stop child processes and release ports. Introduce MCP/tools only through declared capability grants and untrusted-output handling.

Exit criteria: reproduce and fix a browser-visible bug with screenshot/test evidence; concurrent tasks cannot modify one another's worktree; interrupted browser/command work cleans up; conflicting patches require review; failed tests cannot be relabeled as successful by generated prose.

### M4 — infrastructure advantage

Build named SSH/serial/container/Kubernetes profiles with typed settings, actual host/cluster/account identity and environment badges. Preserve OpenSSH host-key checks, agents/hardware-backed authentication and ProxyJump. Bring terminal selection, logs and structured tool output into a task by explicit user selection, with source and capture time attached.

First workflows: failing service + Kubernetes manifest fix; Terraform plan interpretation and proposed patch; CI failure remediation; network/device configuration review against lab captures. Read and propose first. Mutations require request-bound target approval and operational preconditions. Changes to infrastructure require a rollback procedure or explicit irreversibility statement; file checkpoints do not roll back remote systems.

Add opt-in session capture/export with visible recording, retention and deletion controls. Keep physical-console recovery and vendor helpers deliberate; never automatically transmit recovery commands after reconnect. Test port identity separately from identity of the device at the far end.

Exit criteria: choose the right target after flags, context switches, exports and remote hops, or show unknown and block a protected mutation; never leak credentials into profiles/exports; qualify at least the declared macOS/Linux adapter and device matrix; demonstrate the workflows entirely in disposable infrastructure before production trials.

### M5 — daily-driver beta

Add migration for supported shortcuts/settings, transparent compatibility limits, signed/notarized macOS packages, qualified Linux packages, update/rollback handling, crash diagnostics with opt-in data sharing and a repeatable release pipeline. Publish the supported extension/LSP/debugger matrix; do not imply full VS Code extension compatibility without implementing and testing it.

Run a developer pilot and the comparative benchmark below. Expand toward team policy, self-hosted execution and collaboration only after the core workflow earns repeat use. Collaboration needs separate view/control capabilities and revocation; it cannot bypass local policy.

Exit criteria: all benchmark safety/reliability gates pass; product outcomes beat the selected baseline on the declared target cohort; primary keyboard/VoiceOver flows pass; installation/update/rollback and crash recovery pass on supported operating systems.

## Execution backlog: first two iterations

| ID | Concrete work | Acceptance evidence | Depends on |
| --- | --- | --- | --- |
| F01 | Test harness for delayed/rejected IPC, tab lifecycle and clipboard | Tests reproduce AT-03 through AT-07 before fixes | None |
| F02 | Command/context contract and supported-shell spike | Explicit unknown states; fixture cases for AT-01/02; full-screen mode behavior written down | None |
| F03 | PTY attach/replay plus retained exit state | Immediate-output child, delayed attach, ordered overflow and exit tests | None |
| F04 | Session ownership and clipboard fix | Late spawn killed; destination frozen; bracketed paste bytes verified | F01 |
| F05 | Context freshness and approval state machine | Out-of-order responses discarded; failures recoverable; no double submit | F01/F02 |
| F06 | Protected submission/target fixes | All AT-01/02 fixtures pass; unknown protected target cannot execute | F02/F05 |
| F07 | Workspace/editor and OS-isolation architecture spike | Prototype edit/diff/checkpoint plus validated subprocess boundaries on both OSes | F02 |
| F08 | Evaluation fixtures and pilot protocol | Frozen task definitions, baseline versions and scoring instructions | None |

Do not mark M0 complete until F03–F06 are integrated and native checks pass. F07 produces a design decision, not permission to skip editor correctness or isolation tests.

## Evaluation: prove the replacement claim

Build a fixed 40-task corpus: 12 application changes, 8 bug fixes, 6 refactors, 6 infrastructure/configuration changes, 4 terminal/network investigations and 4 recovery/adversarial cases. Include TypeScript, Rust, Python, Go, shell, Terraform and Kubernetes artifacts. Keep a hidden acceptance test or concrete investigator rubric for every task. Use disposable repositories and lab targets.

Run AfterTerm, Cursor and Antigravity against the same initial snapshots, instructions, budgets and completion limits. Record product version, OS, model and settings. Compare both default product configurations and matched models where available; do not call an unmatched-model comparison a runtime-only result. Counterbalance product order, run at least three trials per task, and have reviewers score outcomes without product labels where practical.

| Measure | Proposed beta gate, not a measured result |
| --- | --- |
| Accepted task completion | At least 80% overall; at least 10 percentage points above the strongest measured baseline on the infrastructure subset |
| Time to accepted change | At least 20% lower median than the strongest baseline on the target cohort, without increased defect/rework rate |
| Human review/correction time | No worse than the strongest baseline; report interventions and abandoned tasks |
| Unauthorized or wrong-target side effects | Zero in the declared evaluation suite; any occurrence blocks release |
| Recovery correctness | Zero lost human edits and zero duplicated mutations across injected crash/retry cases |
| Completion honesty | Every passed claim backed by recorded test/evidence; failures and unexecuted checks visibly distinct |
| Cost | Report tokens, model charges and compute per accepted task; budget violations fail the task |
| Retention | Proposed pilot: 10–15 target users over four weeks; at least 70% choose it for their target workflow in the final week |

Report per-task/category outcomes, distributions and uncertainty, not just aggregate averages. Small pilot/corpus results support a scoped claim, not universal superiority. If completion rises but review cost, failures or data loss rise, the product has not won.

Provisional local performance budgets on a documented reference Mac/Linux machine: p95 key-to-paint under 30 ms at idle and under 60 ms under sustained output; p95 shell readiness under 1.5 s warm/3 s cold; task cancel acknowledgement under 250 ms and owned process-tree termination under 2 s where the OS permits. Establish current baselines first and revise budgets transparently if infeasible. Model response latency is measured separately.

## Deferred scope and tradeoffs

Full marketplace compatibility, every language server, Windows support, team sharing, managed identity and legacy enterprise emulation are substantial independent projects. Track demand and explicitly phase them; do not block the first verified coding workflow on all of them. Existing serial functionality remains supported throughout the pivot.

The biggest risks are immature editor behavior, unreliable context identity, unbounded agent scope, credential exposure and crash/retry ambiguity. Each has an explicit owner boundary and milestone gate above. The strategic risk is becoming a broad collection of features before one workflow is excellent; the sample-service and infrastructure demos are the recurring acceptance tests.

## Decisions to record before implementation

- Confirm AfterTerm itself versus an AfterEdit/AfterTerm product strategy; this plan assumes AfterTerm itself and preserves separate installation.
- Select the initial provider/model based on task evaluation, not brand preference; credential handling and cost limits are mandatory either way.
- Choose the editor component and execution isolation mechanisms from F07 evidence.
- Name milestone owners and capacity, then re-estimate after the first iteration.

These are product/architecture choices, not blockers to completing the audit and plan. No implementation, new native installation or release is claimed by this document.
