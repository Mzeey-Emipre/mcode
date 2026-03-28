import { useSyncExternalStore } from "react";

/** Resolved Shiki theme name based on the current app appearance. */
export type ShikiTheme = "github-dark" | "github-light";

/** Returns the current dark-mode class on <html>, reacting to changes. */
function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === "class") {
        callback();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getSnapshot(): ShikiTheme {
  return document.documentElement.classList.contains("dark") ? "github-dark" : "github-light";
}

function getServerSnapshot(): ShikiTheme {
  return "github-dark";
}

/**
 * Returns the resolved Shiki theme name ("github-dark" | "github-light").
 * Reacts to dark-mode class changes on <html>.
 */
export function useShikiTheme(): ShikiTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
