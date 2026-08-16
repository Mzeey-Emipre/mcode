/**
 * Extract plan markdown from Cursor's `cursor/create_plan` ACP extension payload.
 */

/** Pull a markdown string from common Cursor create_plan payload shapes. */
export function extractCursorCreatePlanMarkdown(
  params: Record<string, unknown>,
): string | null {
  const topLevelKeys = ["plan", "markdown", "content", "body", "text"] as const;
  for (const key of topLevelKeys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const nested = params.plan;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    for (const key of ["markdown", "content", "body", "text"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return null;
}
