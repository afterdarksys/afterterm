import { SERIAL_9600, type VendorProfile } from "./types.ts";
export const ARISTA_PROFILES: VendorProfile[] = [{
  id: "arista-eos", vendor: "Arista", label: "EOS switches · 9600",
  appliesTo: "Arista EOS switch consoles using the factory 9600/8N1 settings. Edge Threat Management appliances are a separate product family.",
  settings: { ...SERIAL_9600 },
  notes: [
    "EOS console speed is configurable through boot console speed and boot-config. Match the existing setting rather than changing the switch to fit the terminal.",
    "Connect the serial console with the model's specified RJ45/DB9 cable. The management Ethernet port is separate.",
    "Console paging is disabled by default. A terminal length command entered in global configuration persists; use helpers only from EXEC mode.",
    "Aboot and EOS are distinct environments. EOS CLI helpers should only be used at an EOS EXEC prompt.",
  ],
  recovery: "When the boot prompt invites entry to Aboot, send Ctrl+C (ASCII 3). Serial BREAK is not the documented Aboot entry action. Bootloader passwords and recovery policy may apply.",
  sources: [
    { title: "EOS terminal length scope", url: "https://www.arista.com/en/um-eos/eos-command-line-interface-cli" },
    { title: "EOS boot console settings", url: "https://www.arista.com/en/um-eos/eos-switch-booting-commands" },
    { title: "Aboot shell entry", url: "https://www.arista.com/en/um-eos/eos-aboot-shell" },
    { title: "7050 console cabling", url: "https://www.arista.com/en/qsg-7050-series-1ru-gen3/7050-series-1ru-gen3-cabling-the-switch" },
  ],
  helpers: [{ label: "Disable paging in EXEC session", command: "terminal length 0\n", scope: "session", description: "Only at an EOS EXEC prompt. In global configuration this command changes persistent device settings. Console sessions normally already have paging disabled." }],
}];
