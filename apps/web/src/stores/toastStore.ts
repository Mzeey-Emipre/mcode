import { create } from "zustand";

/** Toast severity level. */
export type ToastLevel = "error" | "info";

/** A single toast notification. */
export interface Toast {
  readonly id: string;
  readonly level: ToastLevel;
  readonly title: string;
  readonly message?: string;
}

/** Maximum number of concurrent toasts before oldest is evicted. */
const MAX_TOASTS = 5;

interface ToastState {
  /** Currently visible toasts (newest first). */
  toasts: Toast[];
  /** Show a toast. Auto-dismisses after `duration` ms (default 5000). */
  show: (level: ToastLevel, title: string, message?: string, duration?: number) => void;
  /** Dismiss a toast by id. */
  dismiss: (id: string) => void;
}

let nextId = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** General-purpose toast notification store. */
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  show: (level, title, message, duration = 5000) => {
    const id = String(++nextId);
    const toast: Toast = { id, level, title, message };
    let toasts = [toast, ...get().toasts];
    // Evict oldest if over cap
    if (toasts.length > MAX_TOASTS) {
      const evicted = toasts.slice(MAX_TOASTS);
      toasts = toasts.slice(0, MAX_TOASTS);
      for (const t of evicted) {
        const timer = timers.get(t.id);
        if (timer) { clearTimeout(timer); timers.delete(t.id); }
      }
    }
    set({ toasts });
    timers.set(id, setTimeout(() => get().dismiss(id), duration));
  },

  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer) { clearTimeout(timer); timers.delete(id); }
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
