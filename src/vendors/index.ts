import { CISCO_PROFILES } from "./cisco.ts";
import type { VendorProfile } from "./types.ts";
export const VENDOR_PROFILES: VendorProfile[] = [...CISCO_PROFILES];
export function vendorProfile(id: string): VendorProfile | undefined {
  return VENDOR_PROFILES.find((profile) => profile.id === id);
}
