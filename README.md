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
Close the tab to release the port; after unplugging, close and reconnect.
Serial sessions currently use UTF-8/xterm rendering and CR on Enter. Break
signaling, reconnect profiles, alternate encodings, recording and remote
sharing remain future work. Physical hardware qualification is still required.

## Appearance and direction

**Appearance → Customize palette** edits terminal and application colors per
preset, including all 16 ANSI colors. Export/import palette JSON or reset the
current palette. Desktop preferences retain overrides, scrollback and cursor
motion settings.

See [product direction](docs/PRODUCT-DIRECTION.md) for the staged access,
emulation, recording, collaboration and enterprise roadmap.
