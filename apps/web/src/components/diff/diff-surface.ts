import { cn } from "@/lib/utils";

/** Card shell shared by turn summaries and per-file diff cards. */
export const DIFF_CARD_SURFACE =
  "overflow-hidden rounded-lg border border-border/40 bg-muted/30";

/**
 * Merges the shared diff card surface with optional extra classes.
 * Keeps turn summaries and inline diff cards on the same visual token.
 */
export function diffCardSurfaceClass(...extra: Array<string | false | null | undefined>): string {
  return cn(DIFF_CARD_SURFACE, ...extra);
}

/** Vertical spacing between sibling file cards in the diff tree. */
export const DIFF_FILE_LIST_GAP = "gap-2";

/**
 * Vertical inset for the scrollable file list body. Full-bleed horizontally so
 * the flat file sections run flush to the panel edges, edge to edge like an
 * IDE diff rather than inset cards.
 */
export const DIFF_FILE_LIST_PADDING = "py-2";
