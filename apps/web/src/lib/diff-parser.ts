/** Parsed diff line with type classification. */
export interface ParsedDiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  /** Original line number in the old file (null for additions and headers). */
  oldLineNo: number | null;
  /** Line number in the new file (null for removals and headers). */
  newLineNo: number | null;
}

/** Parse a unified diff string into typed lines with line numbers. */
export function parseDiffLines(diff: string): ParsedDiffLine[] {
  const lines = diff.split("\n");
  const result: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: "header", content: line, oldLineNo: null, newLineNo: null });
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      result.push({ type: "header", content: line, oldLineNo: null, newLineNo: null });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), oldLineNo: null, newLineNo: newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "remove", content: line.slice(1), oldLineNo: oldLine, newLineNo: null });
      oldLine++;
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      result.push({ type: "context", content, oldLineNo: oldLine, newLineNo: newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}
