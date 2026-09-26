# AfterTerm — the terminal for the datacenter

Build a terminal that feels exceptional in daily use and remains dependable during an incident: fast local shells, precise console access, deep customization, and deliberate collaboration. Standalone on macOS and Linux; no account or AI dependency for local work.

## Baseline and delivered slice

The current code provides native PTY sessions, tabs, search, xterm rendering, optional AI hooks, developer PATH augmentation, and a production Enter gate. These are foundations, not enterprise certification or universal emulation claims.

The appearance slice adds per-theme terminal and application color overrides, all 16 ANSI colors, cursor and selection colors, editable JSON palette exchange, reset, scrollback tuning, and reduced-motion controls. Desktop preferences persist these overrides; browser previews do not persist preferences or run shells.

Direct serial consoles now have native I/O, device discovery, configurable line settings, production submission review, paced paste, BREAK/modem controls, USB identity reconnect, bounded early boot buffering, and documented Cisco/Juniper/Arista/Fortinet presets. A separate SSH compatibility panel generates per-host overrides based on installed client capabilities. These capabilities still require physical hardware qualification; recordings and remote sharing remain planned.

## Delivery sequence

| Stage | Product behavior | Release evidence |
| --- | --- | --- |
| 1. Daily driver | Split panes, workspace restore, command palette, keyboard-first navigation, accessible theme editor, font and rendering tuning | Repeated resize/reconnect/exit tests; vim, tmux, k9s and sustained-output exercises on macOS and Linux; accessibility checks |
| 2. Connection library | Named local, SSH, serial, Telnet, rlogin, Mosh, container and Kubernetes console profiles; folders, tags and environment badges | Per-adapter capability matrix, executable discovery, cancellation, disconnect and credential-error tests |
| 3. Recording | Explicit start/stop indicator, text export and timed replay; per-session retention and destination | Byte fidelity, resize timestamps, bounded storage, disk-full behavior and deletion tests |
| 4. Collaboration | Expiring invitations, view-only by default, explicit control grant, immediate revocation, visible participants | Authorization, reconnect, replay and revoked-session tests; no hidden remote input path around review |
| 5. Managed deployments | Signed distribution, policy configuration, identity integration, audit export, update controls | Policy precedence and tamper tests, signed release verification, independent security review |

## Connection design

Keep connection transport, terminal emulation, authentication, and session policy separate. Profiles contain typed settings, not interpolated shell command strings. Invoke installed clients with argument arrays where appropriate and report missing dependencies. Preserve the desktop developer PATH. Never place credentials in profiles, logs, process arguments, or shared theme/workspace exports.

SSH profiles should support OpenSSH config aliases, agent and hardware-backed authentication, host-key verification, ProxyJump, port forwarding, keepalive and timeout settings. Serial profiles need device selection, baud rate, parity, stop bits and flow control. Telnet and rlogin are explicit legacy adapters with visible transport security information. Container and cluster consoles should use their native clients and preserve context identity.

OAuth2/OIDC is an identity flow for supported gateways and collaboration services, not an emulation mode or replacement for SSH. Design browser authorization with PKCE or device authorization where supported, OS credential storage, token refresh and revocation. Local shells remain available without signing in.

## Emulation and tuning

Do not promise “all modes” by changing TERM. Publish tested compatibility for the actual parser and renderer. Start with xterm-compatible applications and measure alternate-screen behavior, Unicode width, keyboard protocols, mouse reporting, bracketed paste, color, resize and scrollback. Evaluate VT100/VT220, Linux console, ANSI/BBS and specialized enterprise emulation as separate compatibility projects. TN3270/TN5250 require their own protocol/emulation work.

Expose encoding and line-ending behavior only where implemented. Plan per-profile fonts, ligature policy, cursor, bell, contrast, padding, scrollback limits, key mappings, clipboard policy and rendering fallback. Keep user theme overrides isolated from built-in presets. Palette exchange must validate data before application.

## Recording, sharing and policy boundaries

Treat session output as sensitive. Recording is opt-in with an unmistakable indicator and documented retention. Output may contain secrets even when keystrokes are not recorded; redaction cannot be advertised as complete. Plain-text exports and raw replay have different fidelity and exposure properties.

Collaboration needs authenticated encrypted transport, scoped short-lived invitations, separate view/control permissions, participant visibility, and owner revocation. Choose a self-hostable relay architecture before implementation and document what the relay can observe. Route every remote control event through the same authorization and production review boundary as local input.

The existing production gate must be evaluated for remote shells and full-screen applications before extending its protection claims. Local context cannot establish a remote host's production identity. Unknown context and policy failures need explicit behavior that never silently submits an unreviewed Enter.

## Design bar

Keep the working terminal central. Use compact connection and workspace navigation, clear environment identity, legible typography and restrained animation. Every action needs keyboard access and visible focus. Enterprise readiness is demonstrated through tested behavior, recovery, packaging, policy and documentation—not a collection of decorative dashboard controls.
