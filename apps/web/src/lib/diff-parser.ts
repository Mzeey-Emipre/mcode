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
    .filter((l) => !l.isNoNewlineSentinel)
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
  /** True for git's `\ No newline at end of file` hunk metadata line. */
  isNoNewlineSentinel?: boolean;
}

type DiffPosition = {
  oldLine: number;
  newLine: number;
  previousOldEnd: number;
};

const GIT_METADATA_PREFIXES = [
  "+++",
  "---",
  "index ",
  "new file",
  "new mode",
  "old mode",
  "deleted file",
  "similarity",
  "rename",
  "Binary files",
] as const;

function headerLine(content: string): ParsedDiffLine {
  return { type: "header", content, oldLineNo: null, newLineNo: null };
}

function parseHunkHeader(line: string, position: DiffPosition): ParsedDiffLine {
  const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return headerLine(line);

  const oldStart = parseInt(match[1], 10);
  const oldCount = match[2] === undefined ? 1 : parseInt(match[2], 10);
  position.oldLine = oldStart;
  position.newLine = parseInt(match[3], 10);
  const hiddenLineCount = Math.max(0, oldStart - position.previousOldEnd);
  position.previousOldEnd = oldStart + oldCount;
  return { ...headerLine(line), hiddenLineCount };
}

function isGitMetadataLine(line: string): boolean {
  return GIT_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function parseContentLine(line: string, position: DiffPosition): ParsedDiffLine {
  if (line === "\\ No newline at end of file") {
    return {
      type: "context",
      content: line,
      oldLineNo: null,
      newLineNo: null,
      isNoNewlineSentinel: true,
    };
  }
  if (line.startsWith("+")) {
    const parsed = { type: "add" as const, content: line.slice(1), oldLineNo: null, newLineNo: position.newLine };
    position.newLine += 1;
    return parsed;
  }
  if (line.startsWith("-")) {
    const parsed = { type: "remove" as const, content: line.slice(1), oldLineNo: position.oldLine, newLineNo: null };
    position.oldLine += 1;
    return parsed;
  }
  const content = line.startsWith(" ") ? line.slice(1) : line;
  const parsed = { type: "context" as const, content, oldLineNo: position.oldLine, newLineNo: position.newLine };
  position.oldLine += 1;
  position.newLine += 1;
  return parsed;
}

function parseDiffLine(line: string, position: DiffPosition): ParsedDiffLine {
  if (line.startsWith("@@")) return parseHunkHeader(line, position);
  if (line.startsWith("diff ")) {
    position.previousOldEnd = 1;
    return headerLine(line);
  }
  if (isGitMetadataLine(line)) return headerLine(line);
  return parseContentLine(line, position);
}

/** Parse a unified diff string into typed lines with line numbers. */
export function parseDiffLines(diff: string): ParsedDiffLine[] {
  const lines = diff.split("\n");
  // Remove the trailing empty element produced by a diff string that ends with \n
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  // Tracks the line immediately after the last hunk ended.
  // Initialised to 1 so that a hunk starting at line 1 produces hiddenLineCount=0.
  const position: DiffPosition = { oldLine: 0, newLine: 0, previousOldEnd: 1 };
  return lines.map((line) => parseDiffLine(line, position));
}

/** Index of the first `@@` hunk header in parsed lines, or -1 when none. */
export function getFirstHunkHeaderIndex(lines: readonly ParsedDiffLine[]): number {
  return lines.findIndex((line) => line.type === "header" && line.content.startsWith("@@"));
}

/**
 * Hidden line count before the first hunk (lines skipped above the first change).
 * Returns 0 when the diff starts at line 1 or has no hunks.
 */
export function getLeadingHiddenLineCount(lines: readonly ParsedDiffLine[]): number {
  const index = getFirstHunkHeaderIndex(lines);
  if (index < 0) return 0;
  const count = lines[index]?.hiddenLineCount ?? 0;
  return count > 0 ? count : 0;
}
