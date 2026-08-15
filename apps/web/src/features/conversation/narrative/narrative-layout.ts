/**
 * Shared layout classes for narrative tool rows.
 *
 * Flex rows need `min-w-0` and `overflow-hidden` on the container (not only on
 * the truncating child) so long unbroken command strings ellipsize instead of
 * widening the chat column.
 */

/** Constrains a horizontal tool/meta row inside the virtualized chat column. */
export const NARRATIVE_TOOL_ROW =
  "flex min-w-0 max-w-full items-center gap-2 overflow-hidden";

/**
 * Monospace detail text (path, command, pattern) with ellipsis when truncated.
 *
 * @param size - `sm` for active/sub-agent rows, `md` for expanded tool-group rows.
 */
export function narrativeToolDetailClass(size: "sm" | "md"): string {
  const tone =
    size === "md"
      ? "text-sm text-muted-foreground/80"
      : "text-xs text-muted-foreground/65";
  return `font-mono ${tone} truncate flex-1 min-w-0 [overflow-wrap:anywhere]`;
}
