/**
 * Coordinates client-side memory reclamation during background idle.
 * After 60 seconds of window blur: evicts the tool call record cache,
 * dispatches a terminal buffer clear event, and notifies the server
 * to enter background idle mode.
 * On focus: notifies the server to restore normal operation.
 */

import { useEffect } from "react";
import { getTransport } from "@/transport";
import { useThreadStore } from "@/stores/threadStore";

/** Delay before entering background idle after window blur (ms). */
const BACKGROUND_IDLE_DELAY_MS = 60_000;

/** Custom event name dispatched to clear all terminal scrollback buffers. */
export const CLEAR_TERMINAL_BUFFERS_EVENT = "mcode:clear-terminal-buffers";

/**
 * Hook that manages frontend idle reclamation.
 * Mount once in the root App component.
 */
export function useIdleReclamation(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onBlur = () => {
      timer = setTimeout(() => {
        // Notify server to enter background idle
        getTransport().setBackground(true).catch(() => {});

        // Evict client-side caches
        useThreadStore.getState().clearToolCallRecordCache();

        // Clear terminal scrollback buffers
        window.dispatchEvent(new CustomEvent(CLEAR_TERMINAL_BUFFERS_EVENT));
      }, BACKGROUND_IDLE_DELAY_MS);
    };

    const onFocus = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Always notify server on focus to restore normal operation
      getTransport().setBackground(false).catch(() => {});
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
