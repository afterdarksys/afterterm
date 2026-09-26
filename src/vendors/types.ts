import type { ConsoleConfig } from "../console.ts";
export type ConsoleHelper = { label: string; command: string; scope: "session" | "device"; description: string };
export type VendorProfile = {
  id: string; vendor: string; label: string; appliesTo: string;
  settings: Pick<ConsoleConfig, "baud" | "data_bits" | "parity" | "stop_bits" | "flow_control" | "lineEnding" | "backspace">;
  notes: string[];
  recovery: string;
  sources: { title: string; url: string }[];
  helpers: ConsoleHelper[];
};
export const SERIAL_9600 = { baud: 9600, data_bits: 8, parity: "none", stop_bits: 1, flow_control: "none", lineEnding: "cr", backspace: "del" } as const;
export function applyProfile(config: ConsoleConfig, profile: VendorProfile): ConsoleConfig {
  return { ...config, ...profile.settings, profileId: profile.id };
}
