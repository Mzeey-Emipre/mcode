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
    let didEnterBackground = false;

    const onBlur = () => {
      // Guard against double-blur: cancel any pending timer before creating a new one
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(() => {
        didEnterBackground = true;
        timer = null;

        // Notify server to enter background idle
        try {
          getTransport().setBackground(true).catch(() => {});
        } catch {
          // Transport not initialized yet - skip
        }

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
      // Only notify server if we actually entered background idle
      if (didEnterBackground) {
        didEnterBackground = false;
        try {
          getTransport().setBackground(false).catch(() => {});
        } catch {
          // Transport not initialized yet - skip
        }
      }
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
