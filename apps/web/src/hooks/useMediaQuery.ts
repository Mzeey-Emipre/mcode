import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a CSS media query and returns whether it currently matches.
 *
 * Mirrors Tailwind's responsive breakpoints when given the matching query
 * string (e.g. `"(min-width: 768px)"` for `md:`). SSR-safe: returns `false`
 * during the first render, then syncs to the real value on mount.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const mediaQueryList = window.matchMedia(query);
    mediaQueryList.addEventListener("change", notify);
    return () => mediaQueryList.removeEventListener("change", notify);
  }, [query]);
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
