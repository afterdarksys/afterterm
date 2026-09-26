export type SshAlgorithms = { client: string; kex: string[]; host_key: string[]; cipher: string[]; mac: string[] };
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
