import type { ReviewComparison, ReviewFileChange } from "@mcode/contracts";

/** Maximum UTF-8 bytes accepted from a provider-native turn diff. */
export const TURN_DIFF_MAX_BYTES = 2_097_152;
/** Maximum number of parsed lines in a native aggregate. */
export const TURN_DIFF_MAX_LINES = 20_000;
/** Maximum UTF-8 bytes in one native patch line. */
export const TURN_DIFF_MAX_LINE_BYTES = 32_768;

/** Validated text patch and the Review metadata derived from its complete hunks. */
export interface ParsedTurnDiff extends ReviewComparison {
  filePatches: Map<string, string>;
}

interface PatchCursor { lines: string[]; index: number }
interface HunkRange { oldStart: number; oldCount: number; newStart: number; newCount: number }
interface ParsedFile { file: ReviewFileChange; additions: number; deletions: number }

/** Validate a complete text aggregate. Unsupported binary or quoted forms use Git fallback. */
export function parseTurnDiff(patch: string): ParsedTurnDiff | null {
  const lines = boundedLines(patch);
  if (!lines) return null;
  const cursor = { lines, index: 0 };
  const result: ParsedTurnDiff = { files: [], additions: 0, deletions: 0, filePatches: new Map() };
  while (cursor.index < lines.length) {
    const start = cursor.index;
    const parsed = readFile(cursor);
    if (!parsed || result.filePatches.has(parsed.file.path)) return null;
    result.files.push(parsed.file);
    result.additions += parsed.additions;
    result.deletions += parsed.deletions;
    result.filePatches.set(parsed.file.path, lines.slice(start, cursor.index).join("\n") + "\n");
  }
  return result.additions + result.deletions > 0 ? result : null;
}

function boundedLines(patch: string): string[] | null {
  if (!patch || Buffer.byteLength(patch) > TURN_DIFF_MAX_BYTES || patch.includes("\0")) return null;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > TURN_DIFF_MAX_LINES) return null;
  return lines.some((line) => Buffer.byteLength(line) > TURN_DIFF_MAX_LINE_BYTES) ? null : lines;
}

function readFile(cursor: PatchCursor): ParsedFile | null {
  const header = cursor.lines[cursor.index++];
  const metadata = readMetadata(cursor);
  if (!metadata) return null;
  const oldLine = cursor.lines[cursor.index++];
  const newLine = cursor.lines[cursor.index++];
  if (!oldLine?.startsWith("--- ") || !newLine?.startsWith("+++ ")) return null;
  const file = parseFileNames(oldLine.slice(4), newLine.slice(4));
  if (!file || !validFileHeader(header, file, metadata)) return null;
  return readFileHunks(cursor, file);
}

function readMetadata(cursor: PatchCursor): string[] | null {
  const metadata: string[] = [];
  while (cursor.index < cursor.lines.length && !cursor.lines[cursor.index]!.startsWith("--- ")) {
    const line = cursor.lines[cursor.index++]!;
    if (!/^(?:index [a-f0-9]+\.\.[a-f0-9]+(?: [0-7]{6})?|(?:new|deleted) file mode [0-7]{6})$/.test(line)) return null;
    metadata.push(line);
  }
  return metadata;
}

function parseFileNames(oldName: string, newName: string): ReviewFileChange | null {
  const oldPath = readPath(oldName, "a/");
  const newPath = readPath(newName, "b/");
  if (oldPath === undefined || newPath === undefined) return null;
  const path = newPath ?? oldPath;
  if (path === null) return null;
  return { path, previousPath: oldPath !== path ? oldPath : null, binary: false,
    changeType: changeType(oldPath, newPath) };
}

function readPath(name: string, prefix: string): string | null | undefined {
  if (name === "/dev/null") return null;
  if (!name.startsWith(prefix)) return undefined;
  const path = name.slice(2);
  return safePath(path) ? path : undefined;
}

function changeType(oldPath: string | null, newPath: string | null): ReviewFileChange["changeType"] {
  if (oldPath === null) return "added";
  if (newPath === null) return "deleted";
  return oldPath === newPath ? "modified" : "renamed";
}

function validFileHeader(header: string | undefined, file: ReviewFileChange, metadata: string[]): boolean {
  if (header !== `diff --git a/${file.previousPath ?? file.path} b/${file.path}`) return false;
  if (metadata.filter((line) => line.startsWith("index ")).length > 1) return false;
  const modes = metadata.filter((line) => line.includes("file mode"));
  if (modes.length > 1) return false;
  const mode = modes[0] ?? "";
  if (mode.startsWith("new ") && file.changeType !== "added") return false;
  if (mode.startsWith("deleted ") && file.changeType !== "deleted") return false;
  return true;
}

function safePath(path: string): boolean {
  return path.length <= 4096 && !/[\x00-\x1f\x7f\\":]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function readFileHunks(cursor: PatchCursor, file: ReviewFileChange): ParsedFile | null {
  const result: ParsedFile = { file, additions: 0, deletions: 0 };
  let hunks = 0;
  let oldEnd = 0;
  let newEnd = 0;
  while (cursor.lines[cursor.index]?.startsWith("@@ ")) {
    const range = readRange(cursor.lines[cursor.index++]!);
    if (!range || range.oldStart < oldEnd || range.newStart < newEnd) return null;
    const counts = readHunkBody(cursor, range);
    if (!counts) return null;
    oldEnd = range.oldStart + range.oldCount;
    newEnd = range.newStart + range.newCount;
    result.additions += counts.additions;
    result.deletions += counts.deletions;
    hunks++;
  }
  return hunks > 0 ? result : null;
}

function readRange(line: string): HunkRange | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
  if (!match) return null;
  const range = { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]), newCount: Number(match[4] ?? 1) };
  if (!Object.values(range).every(Number.isSafeInteger)) return null;
  if (range.oldCount + range.newCount === 0) return null;
  if (range.oldCount > 0 && range.oldStart === 0) return null;
  if (range.newCount > 0 && range.newStart === 0) return null;
  return range;
}

function readHunkBody(cursor: PatchCursor, range: HunkRange) {
  let oldRemaining = range.oldCount;
  let newRemaining = range.newCount;
  let additions = 0;
  let deletions = 0;
  while (oldRemaining + newRemaining > 0) {
    const effect = lineEffect(cursor.lines[cursor.index++]?.[0]);
    if (!effect) return null;
    oldRemaining -= effect.old;
    newRemaining -= effect.next;
    additions += effect.additions;
    deletions += effect.deletions;
    if (oldRemaining < 0 || newRemaining < 0) return null;
    if (cursor.lines[cursor.index] === "\\ No newline at end of file") cursor.index++;
  }
  return { additions, deletions };
}

function lineEffect(prefix: string | undefined) {
  switch (prefix) {
    case " ": return { old: 1, next: 1, additions: 0, deletions: 0 };
    case "+": return { old: 0, next: 1, additions: 1, deletions: 0 };
    case "-": return { old: 1, next: 0, additions: 0, deletions: 1 };
    default: return null;
  }
}
