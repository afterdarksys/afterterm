import { useEffect, useRef } from "react";

/**
 * Panel focus contract for keyboard and VoiceOver users: on open, focus moves to the
 * element marked data-autofocus (or the panel heading); Escape closes; on close, focus
 * returns to where it was, or to the active terminal.
 */
export function usePanel<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>("h2"))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    node?.addEventListener("keydown", onKey);
    return () => {
      node?.removeEventListener("keydown", onKey);
      const target = previous?.isConnected && previous !== document.body
        ? previous
        : document.querySelector<HTMLElement>(".term-host.is-active .xterm-helper-textarea");
      target?.focus();
    };
  }, []);
  return ref;
}
