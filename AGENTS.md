# AfterTerm

Standalone terminal-centered development workbench for security engineers, network engineers, and developers.
macOS and Linux. Separate product from AfterEdit.

The new product objective is a Cursor/Antigravity alternative; follow
`docs/PRODUCT-ENHANCEMENT-PLAN.md` for staged editor and agent capabilities.
Keep separate installation from AfterEdit. Do not wire the apps together implicitly.

- Audience lives in kubectl, ssh, tcpdump, nmap, k9s, vim, tmux.
- Real PTY first. Full-screen tools must work.
- AI is optional. Shells must work if every AI call errors.
- No account required to open a prompt.
- Reviewed PTY mode holds every CR/LF input packet; unknown targets remain unknown.
- Direct terminal mode explicitly disables review; never claim production protection in that mode.
- Keystroke previews and CLI flags are hints, not authorization or verified target identity.
- Desktop-launched apps need the augmented developer PATH in `path.rs`.
- Tests: `npm test`, `npm run test:integration`, `npm run build`, and `cargo test --workspace`.
