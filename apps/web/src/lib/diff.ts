export interface DiffLine {
  type: "remove" | "add";
  content: string;
}

/**
 * Build a simple unified diff from old and new strings.
 * Shows all old lines as removals followed by all new lines as additions.
 */
export function buildSimpleDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const result: DiffLine[] = [];

  for (const line of oldLines) {
    result.push({ type: "remove", content: line });
  }
  for (const line of newLines) {
    result.push({ type: "add", content: line });
  }

  return result;
}
