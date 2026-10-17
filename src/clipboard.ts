import { isTauri } from "./native.ts";

// The native clipboard plugin works from menu events and keyboard shortcuts alike;
// WKWebView's navigator.clipboard needs a user gesture, so it is only used outside Tauri.
export async function writeClipboard(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    return writeText(text);
  }
  return navigator.clipboard.writeText(text);
}

export async function readClipboard(): Promise<string> {
  if (isTauri()) {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await readText()) ?? "";
  }
  return navigator.clipboard.readText();
}
