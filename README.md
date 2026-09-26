# AfterTerm

**The terminal for the datacenter.**

Terminal emulator for security engineers, network engineers, and developers.
macOS and Linux. Its own product, its own install, its own window.

AfterEdit is the other product: an agentic IDE aimed at VS Code, Cursor,
Windsurf, and Antigravity. AfterTerm is not that. AfterEdit’s look was
reference only.

The emulator is a real PTY. k9s, nmap, tcpdump, tshark, vim, tmux, ssh, and
curses apps have to work — not “work unless you used the AI prompt box.”

AI is a layer, not the floor. No account required to open a shell. Production
commands (`kubectl delete`, `terraform apply`) hold Enter until you type the
context name.

## Why this exists

Warp is a polished command palette with a terminal attached. AfterTerm is a
terminal for people who live in packets, clusters, and shells:

- Standards-compatible PTY (`xterm-256color`, truecolor)
- Installable on its own — no AfterEdit, no account
- macOS and Linux from the start
- Production command bumper
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
cargo test --workspace
```

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

**Appearance → Customize palette** edits terminal and application colors per
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
