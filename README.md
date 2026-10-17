# AfterTerm

**The terminal for the datacenter.**

Terminal emulator for security engineers, network engineers, and developers.
macOS and Linux. Its own product, its own install, its own window.

AfterEdit is the other product: an agentic IDE aimed at VS Code, Cursor,
Windsurf, and Antigravity. AfterTerm is not that. AfterEdit’s look was
reference only.

The emulator is a real PTY. k9s, nmap, tcpdump, tshark, vim, tmux, ssh, and
curses apps have to work — not “work unless you used the AI prompt box.”

AI is a layer, not the floor. No account required to open a shell. New PTY sessions start in
**direct terminal** mode: Enter goes straight to the shell, as in any terminal. The status bar
says **review off**.

**Submission review** is opt-in per tab: press **Enable submission review** in the footer and
every Enter or multiline input packet is held until you approve it in a dialog. Tab, history and
cursor editing cannot silently disable review once it is on. The dialog shows an unverified
explicit target argument when available, otherwise `unknown target`; the app never infers the
shell's target from its own environment. To turn review back off choose **Use direct terminal**
and type `DIRECT`. Review is submission review, not a command sandbox or proof that a
host/account is production. An approved paste may contain several commands; review its entire
contents. Cancel sends Ctrl+C and discards held bytes. Console mode (`afterterm console`) never
reviews.

## Why this exists

Warp is a polished command palette with a terminal attached. AfterTerm is a
terminal for people who live in packets, clusters, and shells:

- Standards-compatible PTY (`xterm-256color`, truecolor)
- Installable on its own — no AfterEdit, no account
- macOS and Linux from the start
- Direct terminal by default, with opt-in per-tab submission review
- Desktop launches still find Homebrew, mise, cargo, asdf

## Run

```sh
npm ci
npm run tauri dev
```

`./build.sh` builds a standalone debug app. On macOS, open
`target/debug/bundle/macos/AfterTerm.app`, or run `target/debug/afterterm`.

```sh
npm test
npm run test:integration
cargo test --workspace
```

## Menus, keyboard and VoiceOver

Every command is in the macOS menu bar with a keyboard shortcut, and the same
shortcut works inside the window. Mod means Command on macOS and Control on Linux.
Panels move keyboard focus to their heading or first control when they open,
close with Escape, and return focus to the terminal. Results such as "Copied 42
characters" or "Theme Nocturne applied" are announced through the status line,
which is a polite live region. Screen reader mode for terminal output is on by
default (Preferences, Terminal behavior).

AfterTerm menu: About AfterTerm; Preferences (Mod+Comma); Services; Hide;
Quit AfterTerm (Mod+Q).

File menu:
- New Tab (Mod+T) and Close Tab (Mod+W).
- Save Transcript (Mod+S) saves the whole scrollback of the active tab as plain
  text. Save Selection (Mod+Shift+S) saves only the selected text. Export
  Transcript as HTML (Mod+Option+S) writes a script-free HTML page with the
  transcript as preformatted text. Escape sequences are removed in all three.
- Log Session to File (Mod+Shift+L) starts or stops appending the active tab's
  raw output, escape sequences included, to a file you choose. The Session Info
  panel shows the path and byte count while it is on. If the disk fails or cannot
  keep up, logging stops (the terminal never waits for the log) and the panel
  announces "Session log stopped" with the reason.
- Print Transcript (Mod+P) prints the scrollback as plain text.

Files are chosen in the native save dialog, which runs in the Rust side; the web
view never supplies a path. AfterTerm refuses symbolic links, hard-linked files,
devices and FIFOs, files owned by another user, and anything inside its own
configuration or data folders, and leaves saved files readable only by you
(mode 0600).

Edit menu: Cut (Mod+X), Copy (Mod+C), Paste (Mod+V), Select All (Mod+A),
Clear Selection (Mod+Shift+A), Find (Mod+F), Explain Selection (Mod+Shift+E).
Copy uses the system clipboard directly. Terminal output cannot be deleted, so
Cut copies the selection and then clears it, and says so. Paste goes through the
same path as typing: bracketed paste is honored and, when submission review is on
for the tab, the Enter is held for approval. In a text field inside a panel these
commands act on that field instead of the terminal. Copy on select is an option
in Preferences and is off by default.

Shell menu:
- Clear Scrollback (Mod+K).
- Reset Terminal (Mod+Option+R) resets the screen and types stty sane into the
  session, followed by Enter.
- Show Terminal Settings types stty -a; the settings appear as terminal output.
- Send Control-C (Control+Shift+C) and the Send Signal submenu: SIGINT, SIGTSTP,
  SIGQUIT, SIGHUP and SIGTERM. Signals go to the foreground process group of the
  tab's terminal, and only when that group belongs to the tab's own session;
  otherwise to the tab's own program.
- Toggle Submission Review (Mod+Shift+R). Turning review off still asks you to
  type DIRECT.
- Connect SAH (Mod+Shift+H), Connect Serial Console (Mod+Shift+O) and SSH
  Compatibility (Mod+Shift+K).

Commands that type into the session never run on their own: each one needs you to
choose it, and each goes through the normal input path, so review applies. When
the shell is in the foreground, AfterTerm first sends Control-U to clear anything
already typed on the command line; this assumes a readline-style line editor such
as bash, zsh or fish. When another program is in the foreground (vim, ssh, a router
CLI), the text would go to that program instead, so you must type SEND to confirm.

View menu: Session Info (Mod+I); Bigger Text (Mod+Equals), Smaller Text
(Mod+Minus), Default Text Size (Mod+0); Preferences and Themes.

Window menu: Minimize, Zoom, Next Tab (Mod+Shift+Right Bracket), Previous Tab
(Mod+Shift+Left Bracket).

### Session Info panel

For the active tab it lists: tab title, transport, program and arguments (the
SAH host for a SAH tab), process ID, foreground process group, current
directory, rows and columns, start time, bytes received and sent, exit code,
submission review state, and session log state. It refreshes every second.

Below the facts are labeled controls: one button per signal; Reset terminal;
Show current settings (stty -a); a stty section with a Leave unchanged, Turn on
or Turn off choice for echo, icanon, isig and ixon, and fields for the erase,
interrupt and end-of-file characters in caret notation (for example ^H, ^? or
^C) or the word undef. The section shows the single stty command it will send
and sends it only when you press Apply. A checkbox turns the session log on or
off. Serial tabs show their port settings; signals, stty and logging apply to
local terminal tabs only.

### Preferences panel

Sections, each with a heading: Theme and colors (theme by name; per-theme colors
accept a name such as red, navy or amber, a hex value, or rgba, and each field
reads back the current value and its nearest color name; palette export and
import as JSON; window transparency), Text (font, size, line height), Cursor and
bell (shape, blink, reduce motion, bell none, sound or visual flash), Terminal
behavior (screen reader mode, Option as Meta, copy on select, scrollback lines,
start new tabs with submission review on, which is off by default), AI, and
Reset all preferences to defaults, which asks for confirmation first.

## Reliability and product direction

PTY output is retained in a bounded 256 KiB history with sequence numbers so a
late renderer can recover initial output and exit state. Overflow is reported.
Review requests are bound to their session and request ID; retrying an acknowledged
request cannot submit a newer one. Shortcut paste respects xterm bracketed paste
and stays bound to the session selected when the clipboard read started.

See [reliability verification](docs/RELIABILITY-VERIFICATION.md) for test evidence
and remaining platform qualification. The [enhancement plan](docs/PRODUCT-ENHANCEMENT-PLAN.md)
sets the proposed direction toward a standalone agentic workbench competing with
Cursor and Antigravity. Editor and agent-runtime milestones remain planned.

For browser integration tests, install Playwright's Chromium (`npx playwright install chromium`)
or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium executable.
The tests run the actual React/xterm UI against explicit mocked native IPC.

## Launch modes and SAH

The current GUI terminal type is xterm-compatible (xterm.js), with
`TERM=xterm-256color` and `COLORTERM=truecolor` in local PTYs. Serial tabs use the
same renderer. There is no terminal-type selector or separately qualified
VT100/VT220, Linux-console, ANSI/BBS, TN3270 or TN5250 emulator. Console launch
mode uses the invoking terminal's renderer and inherits its `TERM`.

AfterTerm uses the existing Go `sahconnect` executable for SAH connections.
Install it separately on your developer PATH; protocol, TLS, authentication,
remote resize and remote exit handling remain owned by that client. Local shells
do not require SAH, an account, or AI. AfterEdit remains a separate installation.

```sh
afterterm gui                       # desktop with a local shell
afterterm console                   # local shell in the current terminal
afterterm gui connect web1          # SAH client in a desktop PTY tab
afterterm console connect web1      # SAH client in the current terminal
afterterm console login             # SAH device login
afterterm gui connect web1 --root    # forwarded to sahconnect; requires its authorization
afterterm --help
```

The desktop **Connect SAH** panel provides host connection and device login.
It uses `sahconnect`'s existing server configuration and credential store;
AfterTerm does not copy tokens into its preferences. Each new ordinary tab still
opens a local shell. Connection arguments are passed literally, without shell
interpolation. Use `--` after the mode to forward client help, e.g.
`afterterm console -- --help`.

Set `$XDG_CONFIG_HOME/afterterm/launch.json` (default
`~/.config/afterterm/launch.json`) to:

```json
{ "default_mode": "gui" }
```

Choose `"console"` for a TTY default. Explicit `gui` or `console` wins over the
configured mode; without either, arguments go to the configured interface.
With no arguments, it opens a local shell. `AFTERTERM_CONFIG` selects another
config file, which must exist. Missing default files use GUI; malformed files,
unknown settings, and invalid modes report an error. This launcher file is
separate from desktop appearance preferences and SAH's own config.

GUI sessions start in direct mode. Submission review is opt-in per tab (footer
button, Shell > Toggle Submission Review, or the "start new tabs with submission
review on" preference); when it is on, every CR/LF input packet is held for
review. Console mode is always direct, with no AfterTerm input review;
it preserves the client's controlling TTY, signals, pipes and exit status.
AfterTerm does not infer verified remote target identity from a host argument
or client output. SAH server policy and authorization remain the client's and
server's responsibility. This is a CLI-backed integration, not a Rust protocol
implementation or a bundled SAH installation. Console mode currently uses the
same desktop-linked binary, not a separate minimal server package.

## Direct console access

Use **Connect console** in the desktop app to select a detected serial device
or enter a `/dev/` path. Configure baud rate, 5–8 data bits, parity, stop bits,
and software/hardware/no flow control. Defaults are 9600 baud, 8N1, no flow
control; use the settings required by your equipment.

This is native serial I/O, not an SSH session or a wrapper around `screen`.
Use a compatible USB console cable or serial adapter with the correct pinout
and electrical signaling for the device. On macOS, select the adapter's
`/dev/cu.*` device; on Linux, use its accessible `/dev/ttyUSB*` or `/dev/ttyACM*`
device. Required OS drivers and device permissions still apply.

Production console mode holds each Enter or multiline paste until the device
path is typed to confirm. Cancel drops the pending input and sends Ctrl+C.
This is submission review, not vendor-specific command classification.
Close the tab to release the port. Console controls provide explicit reconnect;
optional automatic reconnect follows a unique USB VID/PID/serial identity and
refuses ambiguous matches. Adapters without an identity require manual selection.
Auto-reconnect can follow the adapter, not identify the equipment at its far end.
Console settings and reconnect choices currently live for the tab's lifetime.

Serial sessions use UTF-8/xterm rendering with configurable CR/LF/CRLF, Backspace,
and local echo. Console controls include real BREAK (50–2000 ms), Ctrl+C, Esc,
and DTR/RTS; driver-controlled RTS cannot be overridden with hardware flow control.
Hardware support for these signals depends on the adapter and driver.

Clipboard paste and CLI helpers open an editable review with byte/line pacing,
progress and cancellation. Production pastes require the device path before
sending. Cancellation stops remaining bytes; it cannot recall bytes already sent.
Control characters other than tab and line endings are rejected in pasted text.
Early output is buffered from port open until the renderer attaches (256 KiB
maximum, with an explicit truncation message). This is not persistent recording.

Alternate encodings, persistent session recordings and remote sharing remain
future work. Physical hardware qualification is still required.

## Appearance and direction

**Preferences, Customize colors** edits terminal and application colors per
preset, including all 16 ANSI colors. Export/import palette JSON or reset the
current palette. Desktop preferences retain overrides, scrollback and cursor
motion settings.

See [product direction](docs/PRODUCT-DIRECTION.md) for the staged access,
emulation, recording, collaboration and enterprise roadmap.

## Vendor console profiles

Choose a device profile in **Connect console**, then override settings as needed.
Each includes model/family scope, cable/driver notes, recovery guidance and vendor
source links. Profiles never send setup or recovery commands on connection.

| Profile | Default speed | Important distinction |
| --- | --- | --- |
| Cisco IOS / IOS XE | 9600 | Real BREAK differs from Ctrl+C; USB input can take precedence on Catalyst 9300 |
| Juniper Junos | 9600 | Active USB/RJ45 console selection and early boot visibility are platform-dependent |
| Arista EOS | 9600 | Aboot uses Ctrl+C; paging command scope depends on CLI mode |
| Fortinet FortiGate | 9600 | Paging helpers change device configuration |
| Fortinet FortiAP | 115200 | FortiGate CLI helpers do not apply |
| Fortinet FortiSwitch 424D | 115200 | Explicitly scoped to the documented switch family |

Under **Console controls**, vendor helpers display their exact command and scope,
then open paste review. Ensure the current device prompt is in the specified mode.
AfterTerm does not infer vendor or CLI mode from a USB adapter or prompt.

## SSH compatibility

**SSH compatibility** queries the installed OpenSSH client's supported algorithms
with `ssh -Q`, using the desktop developer PATH. It generates a reviewable config
stanza for one exact hostname/IP and appends chosen algorithms to defaults.
It neither connects to a host nor edits `~/.ssh/config`. Host-key checking is not
weakened, and algorithms removed from the installed client are not offered.
See [OpenSSH's compatibility guidance](https://www.openssh.org/legacy.html).

## Qualification

Automated checks cover profile scope, input mappings, ambiguous reconnects,
serial production review over a virtual TTY pair, paced-write cancellation,
bounded boot buffering, and scoped SSH overrides. Hardware BREAK/DTR/RTS,
USB unplug/replug, boot timing, OS drivers and individual devices still need
macOS and Linux qualification. Vendor presets are documented starting points,
not a certification that every model from a vendor has been tested.
