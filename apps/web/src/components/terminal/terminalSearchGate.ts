/** Search presentation variants available to the throwaway Terminal prototype. */
export type TerminalSearchVariant = "island" | "lane" | "shelf";

/** Window event used to keep the gated presentation in sync across terminal views. */
export const TERMINAL_SEARCH_VARIANT_EVENT = "mcode:terminal-search-variant";

const TERMINAL_SEARCH_VARIANTS: readonly TerminalSearchVariant[] = [
  "island",
  "lane",
  "shelf",
];

/** Returns true when a value is one of the supported prototype variants. */
export function isTerminalSearchVariant(
  value: unknown,
): value is TerminalSearchVariant {
  return typeof value === "string" && TERMINAL_SEARCH_VARIANTS.includes(value as TerminalSearchVariant);
}

/** Returns the requested prototype variant, or null when the prototype is gated off. */
export function getTerminalSearchVariant(search?: string): TerminalSearchVariant | null {
  if (!import.meta.env.DEV) return null;
  const currentSearch = search ?? (typeof window === "undefined" ? "" : window.location.search);
  const value = new URLSearchParams(currentSearch).get("terminalSearchVariant");
  return isTerminalSearchVariant(value) ? value : null;
}

/** Returns the next or previous prototype variant with wraparound. */
export function cycleTerminalSearchVariant(
  variant: TerminalSearchVariant,
  direction: "next" | "previous",
): TerminalSearchVariant {
  const index = TERMINAL_SEARCH_VARIANTS.indexOf(variant);
  const offset = direction === "next" ? 1 : -1;
  return TERMINAL_SEARCH_VARIANTS[
    (index + offset + TERMINAL_SEARCH_VARIANTS.length) % TERMINAL_SEARCH_VARIANTS.length
  ];
}
