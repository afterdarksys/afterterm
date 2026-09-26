import { SERIAL_9600, type VendorProfile } from "./types.ts";
export const CISCO_PROFILES: VendorProfile[] = [{
  id: "cisco-ios", vendor: "Cisco", label: "IOS / IOS XE · 9600",
  appliesTo: "IOS/IOS XE serial consoles using 9600/8N1, including the Catalyst 9300 default. Not a universal Nexus, ASA, or IOS XR preset.",
  settings: { ...SERIAL_9600 },
  notes: [
    "Use the device's console cable and pinout. An RJ45 console connector is not an Ethernet management port.",
    "On Catalyst 9300, an active USB console takes input precedence over RJ45. If RJ45 output works but typing does not, check the USB connection.",
    "Catalyst 9300 hardware can expose Cisco USB or Silicon Labs CP2102N devices. Check the hardware guide and OS driver support if no port appears.",
    "Console speed may have been changed. Garbled output warrants checking the configured speed before sending commands.",
  ],
  recovery: "Some IOS/IOS XE routers require a real serial BREAK during boot; use Send BREAK, not Ctrl+C. Timing and recovery policy are model-specific. Catalyst recovery may instead require a physical Mode button. No recovery command is sent automatically.",
  sources: [
    { title: "Catalyst 9300 console hardware", url: "https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/Configuring-a-switch.html" },
    { title: "Catalyst 9300 console precedence", url: "https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-14/configuration_guide/int_hw/b_1714_int_and_hw_9300_cg/configuring_interface_characteristics.html" },
    { title: "IOS / IOS XE recovery", url: "https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-xe-16/217045-troubleshoot-password-recovery-in-cisco.html" },
    { title: "IOS terminal commands", url: "https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/command/reference/cf_book/cf_s5.html" },
  ],
  helpers: [
    { label: "Disable paging", command: "terminal length 0\n", scope: "session", description: "Run from an IOS/IOS XE EXEC prompt. Sets the current session's screen length to unlimited." },
    { label: "Set paging to 24 lines", command: "terminal length 24\n", scope: "session", description: "Sets a specific screen length; does not restore an unknown previous value." },
  ],
}];
