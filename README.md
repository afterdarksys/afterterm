# AfterTerm

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
