# AfterTerm

Standalone terminal for security engineers, network engineers, and developers.
macOS and Linux. Separate product from AfterEdit.

AfterEdit is the agentic IDE (VS Code / Cursor / Windsurf / Antigravity).
Do not wire the two apps together. AfterEdit’s workbench pane was visual
reference only.

- Audience lives in kubectl, ssh, tcpdump, nmap, k9s, vim, tmux.
- Real PTY first. Full-screen tools must work.
- AI is optional. Shells must work if every AI call errors.
- No account required to open a prompt.
- Production gate fails closed: unreviewed Enter is not submitted.
- Desktop-launched apps need the augmented developer PATH in `path.rs`.
- Tests: `npm test` and `cargo test --workspace`.
