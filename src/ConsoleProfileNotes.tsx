import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./native.ts";
import type { VendorProfile } from "./vendors/types.ts";
export function ConsoleProfileNotes({ profile }: { profile: VendorProfile }) {
  return <div className="profile-notes">
    <p>{profile.appliesTo}</p>
    <ul>{profile.notes.map((note) => <li key={note}>{note}</li>)}</ul>
    <p><strong>Recovery:</strong> {profile.recovery}</p>
    <p>Defaults are a starting point. Match the actual model, firmware, and configured console speed.</p>
    {profile.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" onClick={(e) => { if (isTauri()) { e.preventDefault(); void openUrl(source.url); } }}>{source.title}</a>)}
  </div>;
}
