export type ConsoleConfig = {
  path: string; baud: number; data_bits: number; parity: string;
  stop_bits: number; flow_control: string; production: boolean;
  lineEnding: "cr" | "lf" | "crlf";
  backspace: "bs" | "del";
  localEcho: boolean;
  profileId: string;
  identity?: string;
  autoReconnect?: boolean;
};
export const DEFAULT_CONSOLE: ConsoleConfig = {
  path: "", baud: 9600, data_bits: 8, parity: "none", stop_bits: 1,
  flow_control: "none", production: true, lineEnding: "cr", backspace: "del",
  localEcho: false, profileId: "generic",
};
export function consoleInput(data: string, config: ConsoleConfig): string {
  const newline = { cr: "\r", lf: "\n", crlf: "\r\n" }[config.lineEnding];
  return data.replace(/\r\n|\r|\n/g, newline).replace(/\x7f/g, config.backspace === "bs" ? "\b" : "\x7f");
}

export type ConsolePort = { path: string; label: string; identity: string | null };
export function reconnectPath(config: ConsoleConfig, ports: ConsolePort[]): string {
  if (!config.identity) {
    if (config.autoReconnect) throw new Error("Automatic reconnect requires a unique USB identity");
    return config.path;
  }
  const matches = ports.filter((port) => port.identity === config.identity);
  if (matches.length !== 1) throw new Error(matches.length ? "Multiple ports match this adapter; select the device manually" : "Waiting for the original USB adapter");
  return matches[0].path;
}
