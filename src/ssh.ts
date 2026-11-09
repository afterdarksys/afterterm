export type SshAlgorithms = { client: string; kex: string[]; host_key: string[]; cipher: string[]; mac: string[] };

/** Structured OpenSSH target. The client builds no argv; Rust does. */
export type SshTarget = { host: string; user: string | null; port: number | null };

const NAME_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.]{2,45}\]$/;
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

function validHost(host: string): boolean {
  if (NAME_HOST.test(host)) return true;
  return BRACKETED_IPV6.test(host) && host.slice(1, -1).includes(":");
}

/** Empty text is the OpenSSH default port. Any other text must be 1–65535. */
export function sshPort(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * `user@host` or `host` when the fields are safe to hand to OpenSSH.
 * Returns null when the host, user, or port would be rejected. This is a
 * destination label, not a verified remote identity.
 */
export function sshDestination(target: { host: string; user?: string | null; port?: number | null }): string | null {
  const host = target.host.trim();
  if (!validHost(host)) return null;
  const user = (target.user ?? "").trim();
  if (user && !SSH_USER.test(user)) return null;
  const port = target.port ?? null;
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return user ? `${user}@${host}` : host;
}

/** Token after `--` when the program is the OpenSSH client. Not a verified identity. */
export function sshSessionDestination(program: string, args: readonly string[]): string | null {
  if (program.split(/[/\\]/).pop() !== "ssh") return null;
  const marker = args.indexOf("--");
  if (marker < 0 || marker + 1 >= args.length) return null;
  const dest = args[marker + 1];
  if (!dest || dest.startsWith("-") || /\s/.test(dest)) return null;
  return dest;
}
export const SSH_OPTIONS = { kex: "KexAlgorithms", host_key: "HostKeyAlgorithms", cipher: "Ciphers", mac: "MACs" } as const;
export type SshOverrides = Partial<Record<keyof typeof SSH_OPTIONS, string>>;
export function sshHostConfig(host: string, overrides: SshOverrides, available: SshAlgorithms): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(host)) throw new Error("Enter one hostname or IP address, without wildcards, spaces, or a username");
  const lines = [`Host ${host}`];
  for (const key of Object.keys(SSH_OPTIONS) as (keyof SshOverrides)[]) {
    const value = overrides[key];
    if (!value) continue;
    if (!available[key].includes(value) || !/^[a-zA-Z0-9@._+-]+$/.test(value)) throw new Error(`Unsupported ${SSH_OPTIONS[key]} algorithm`);
    lines.push(`    ${SSH_OPTIONS[key]} +${value}`);
  }
  if (lines.length === 1) throw new Error("Select an override only if the connection requires it");
  return `${lines.join("\n")}\n`;
}
