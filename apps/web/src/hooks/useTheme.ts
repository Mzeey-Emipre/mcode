import { useSyncExternalStore } from "react";

/** Resolved Shiki theme name based on the current app appearance. */
export type ShikiTheme = "github-dark" | "github-light";

/**
 * Shared subscription for dark-mode class changes on `<html>`.
 * A single MutationObserver is created when the first subscriber registers,
 * and disconnected when the last subscriber unregisters.
 */
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function startObserver() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === "class") {
        for (const cb of listeners) cb();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

function stopObserver() {
  if (observer && listeners.size === 0) {
    observer.disconnect();
    observer = null;
  }
}

/** Subscribes to dark-mode class changes. Shares a single MutationObserver across all callers. */
function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  startObserver();
  return () => {
    listeners.delete(callback);
    stopObserver();
  };
}

/** Returns the current Shiki theme based on the `dark` class on `<html>`. */
function getSnapshot(): ShikiTheme {
  return document.documentElement.classList.contains("dark") ? "github-dark" : "github-light";
}

/** SSR fallback (unused in Electron, satisfies useSyncExternalStore API). */
function getServerSnapshot(): ShikiTheme {
  return "github-dark";
}

/**
 * Returns the resolved Shiki theme name ("github-dark" | "github-light").
 * Reacts to dark-mode class changes on `<html>`. All consumers share a single MutationObserver.
 */
export function useShikiTheme(): ShikiTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
