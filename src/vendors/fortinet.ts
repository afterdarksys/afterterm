import { SERIAL_9600, type VendorProfile } from "./types.ts";
export const FORTINET_PROFILES: VendorProfile[] = [
  {
    id: "fortinet-fortigate", vendor: "Fortinet", label: "FortiGate / FortiOS · 9600",
    appliesTo: "FortiGate serial console at the documented default. Not a blanket preset for every Fortinet product.",
    settings: { ...SERIAL_9600 },
    notes: [
      "FortiGate console speed can be changed. Match the device's current baud rate.",
      "FortiOS paging changes below modify system console configuration, rather than a disposable client preference.",
      "Use the console cable/pinout documented for the appliance. A USB storage socket is not necessarily a USB console.",
    ],
    recovery: "FortiGate boot menus may ask you to press any key during a short boot window. Use the actual prompt and model guide; do not substitute Cisco BREAK. Formatting and firmware recovery are never automated.",
    sources: [
      { title: "FortiGate and FortiAP console settings", url: "https://community.fortinet.com/fortigate-3/technical-tip-how-to-connect-to-the-fortigate-and-fortiap-console-port-109949" },
      { title: "FortiOS system console reference", url: "https://docs.fortinet.com/document/fortigate/7.2.7/cli-reference/107620/config-system-console" },
      { title: "FortiGate boot menu", url: "https://docs.fortinet.com/document/fortigate/7.6.6/administration-guide/556915/installing-firmware-from-system-reboot" },
    ],
    helpers: [
      { label: "Disable output paging", command: "config system console\nset output standard\nend\n", scope: "device", description: "Changes FortiOS system console configuration. Start at the top-level CLI with the required privileges; it is not scoped to this AfterTerm session." },
      { label: "Enable output paging", command: "config system console\nset output more\nend\n", scope: "device", description: "Changes FortiOS system console configuration to paged output. Does not restore an unknown previous setting." },
    ],
  },
  {
    id: "fortinet-fortiap", vendor: "Fortinet", label: "FortiAP · 115200",
    appliesTo: "FortiAP console using the documented 115200 baud setting. Check the exact AP model for console availability and cabling.",
    settings: { ...SERIAL_9600, baud: 115200 },
    notes: ["FortiAP uses a different default speed from FortiGate.", "FortiOS system console helpers are intentionally not offered for FortiAP."],
    recovery: "Follow the model's boot prompt and recovery guide. FortiGate boot-menu procedures are not assumed to apply to an access point.",
    sources: [{ title: "FortiAP console settings", url: "https://community.fortinet.com/fortigate-3/technical-tip-how-to-connect-to-the-fortigate-and-fortiap-console-port-109949" }],
    helpers: [],
  },
  {
    id: "fortinet-fortiswitch-424d", vendor: "Fortinet", label: "FortiSwitch 424D series · 115200",
    appliesTo: "FortiSwitch 424D series console settings from its quick-start guide. Confirm other switch models separately.",
    settings: { ...SERIAL_9600, baud: 115200 },
    notes: ["This profile is scoped to the documented 424D family, not every FortiSwitch.", "FortiGate configuration helpers are not reused for managed switches."],
    recovery: "Use the specific switch's recovery guide and boot prompt. No reset or firmware commands are bundled.",
    sources: [{ title: "FortiSwitch 424D quick-start guide", url: "https://fortinetweb.s3.amazonaws.com/docs.fortinet.com/v2/attachments/ddbf2e0b-202f-11e9-b6f6-f8bc1258b856/FortiSwitch-424D-Series-QuickStart.pdf" }],
    helpers: [],
  },
];
