/**
 * Returns true when the file path has a `.md` or `.mdx` extension (case-insensitive).
 * Used to decide whether to show the markdown preview toggle in the diff toolbar.
 */
export function isMarkdownFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return ext === "md" || ext === "mdx";
}

/**
 * Reconstructs the new (post-change) content of a file from its parsed diff lines.
 *
 * Only `add` and `context` lines contribute to the result; `remove` and `header` lines
 * are omitted. Lines are joined with `\n`.
 *
 * Limitation: when a diff only covers hunks (not the full file), lines outside the hunks
 * are not included. The reconstructed content is therefore hunk-only and may be incomplete
 * for large files with changes in the middle. This is acceptable for the Phase 1 preview,
 * which is intended for markdown files where diffs typically cover most of the file.
 */
export function reconstructNewContent(lines: ParsedDiffLine[]): string {
  return lines
    .filter((l) => l.type === "add" || l.type === "context")
    .filter((l) => l.content !== "\\ No newline at end of file")
    .map((l) => l.content)
    .join("\n");
}

/** Parsed diff line with type classification. */
export interface ParsedDiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  /** Original line number in the old file (null for additions and headers). */
  oldLineNo: number | null;
  /** Line number in the new file (null for removals and headers). */
  newLineNo: number | null;
  /**
   * Number of file lines hidden before this hunk. Only set on `@@` hunk header
   * lines. Used to render "N unchanged lines" separator bars in the diff view.
   */
  hiddenLineCount?: number;
}

/** Parse a unified diff string into typed lines with line numbers. */
export function parseDiffLines(diff: string): ParsedDiffLine[] {
  const lines = diff.split("\n");
  // Remove the trailing empty element produced by a diff string that ends with \n
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const result: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  // Tracks the line immediately after the last hunk ended.
  // Initialised to 1 so that a hunk starting at line 1 produces hiddenLineCount=0.
  let prevOldEnd = 1;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const oldStart = parseInt(match[1], 10);
        const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        newLine = parseInt(match[3], 10);
        oldLine = oldStart;

        // Lines hidden between the end of the previous hunk and the start of this one.
        // For the first hunk, this equals lines before it in the file (oldStart - 1).
        const hiddenLineCount = Math.max(0, oldStart - prevOldEnd);
        prevOldEnd = oldStart + oldCount;

        result.push({
          type: "header",
          content: line,
          oldLineNo: null,
          newLineNo: null,
          hiddenLineCount,
        });
      } else {
        result.push({ type: "header", content: line, oldLineNo: null, newLineNo: null });
      }
    } else if (line.startsWith("diff ")) {
      // New file section in a multi-file diff: reset hunk tracking for the new file
      prevOldEnd = 1;
      result.push({ type: "header", content: line, oldLineNo: null, newLineNo: null });
    } else if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("new mode") ||
      line.startsWith("old mode") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity") ||
      line.startsWith("rename") ||
      line.startsWith("Binary files")
    ) {
      // Git metadata lines — mark as header so renderers can skip them
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
