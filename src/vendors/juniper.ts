import { SERIAL_9600, type VendorProfile } from "./types.ts";
export const JUNIPER_PROFILES: VendorProfile[] = [{
  id: "juniper-junos", vendor: "Juniper", label: "Junos · 9600",
  appliesTo: "Junos consoles documented for 9600/8N1, including SRX345 and MX960. Verify other platforms against their hardware guide.",
  settings: { ...SERIAL_9600 },
  notes: [
    "Some EX/SRX platforms require selecting the active RJ45 or USB console. Port activation may require configuration and a reboot; connecting a cable alone is insufficient.",
    "Early boot output and debugger access can depend on which console is active. Read the hardware guide before switching ports.",
    "SRX345 mini-USB and USB serial adapters may need an OS-compatible driver. Driver requirements vary by hardware and operating system.",
    "Paging helpers below are for the Junos operational CLI, not a shell or the configuration editor.",
  ],
  recovery: "Boot interruption and recovery vary by platform and Junos versus Junos OS Evolved. Follow the model-specific guide and visible boot prompt. Do not assume Cisco BREAK behavior or automatically switch the active console port.",
  sources: [
    { title: "Junos console port selection", url: "https://www.juniper.net/documentation/us/en/software/junos/user-access/topics/task/console-port-type-ex-series-cli.html" },
    { title: "SRX345 console settings and drivers", url: "https://www.juniper.net/documentation/us/en/hardware/srx345/topics/topic-map/srx345-configuring-junos.html" },
    { title: "MX960 console connection", url: "https://www.juniper.net/documentation/us/en/hardware/mx960/topics/task/port-mx960-console-aux-connecting.html" },
    { title: "Junos screen length", url: "https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/set-cli-screen-length-junos-cli.html" },
  ],
  helpers: [
    { label: "Disable paging", command: "set cli screen-length 0\n", scope: "session", description: "Changes the operational CLI screen length for this session. Does not commit a device configuration." },
    { label: "Set paging to 24 lines", command: "set cli screen-length 24\n", scope: "session", description: "Sets a specific length; does not restore an unknown previous value." },
  ],
}];
