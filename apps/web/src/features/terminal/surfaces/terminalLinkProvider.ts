/** A validated absolute Terminal file target. */
export interface TerminalLinkTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/** A validated link and its character range within one Terminal line. */
export interface TerminalLinkMatch {
  readonly target: TerminalLinkTarget;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A minimal xterm cell view used to translate text offsets to cell columns. */
export interface TerminalLinkCell {
  readonly getChars: () => string;
  readonly getWidth: () => number;
}

/** A minimal xterm buffer line used by the link range adapter. */
export interface TerminalLinkCellLine {
  readonly length: number;
  readonly getCell: (index: number) => TerminalLinkCell | undefined;
}

/** An inclusive-start, exclusive-end range measured in xterm cell columns. */
export interface TerminalLinkCellRange {
  readonly start: number;
  readonly end: number;
}

const LOCATION_LIMIT = 1_000_000;
const TRAILING_PUNCTUATION = /[\])}>,.;!?]+$/;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Parses one Terminal file link without accepting URLs or traversal paths. */
export function parseTerminalLink(value: string): TerminalLinkTarget | null {
  const candidate = value.trim().replace(TRAILING_PUNCTUATION, "");
  const location = /^(.*?)(?::([0-9]+))?(?::([0-9]+))?$/.exec(candidate);
  if (!location) return null;

  const path = location[1];
  if (
    !path ||
    path.length > 2_048 ||
    containsControlCharacter(path) ||
    path.includes("://") ||
    path.split(/[\\/]/).includes("..") ||
    !(/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/"))
  ) {
    return null;
  }

  const line = location[2] ? Number(location[2]) : undefined;
  const column = location[3] ? Number(location[3]) : undefined;
  if (
    (line !== undefined && (!Number.isSafeInteger(line) || line < 1 || line > LOCATION_LIMIT)) ||
    (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > LOCATION_LIMIT))
  ) {
    return null;
  }
  return {
    path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

/** Finds all safe absolute file targets in one Terminal line. */
export function findTerminalLinks(value: string): readonly TerminalLinkMatch[] {
  const candidatePattern = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+)/g;
  const links: TerminalLinkMatch[] = [];
  for (const match of value.matchAll(candidatePattern)) {
    const text = match[1];
    const target = parseTerminalLink(text);
    if (!target || match.index === undefined) continue;
    const start = match.index + (match[0].length - text.length);
    links.push({ target, text, start, end: start + text.length });
  }
  return links;
}

/** Maps one text range onto xterm cell columns, preserving wide characters. */
export function terminalLinkCellRange(
  line: TerminalLinkCellLine,
  match: Pick<TerminalLinkMatch, "start" | "end">,
): TerminalLinkCellRange | null {
  let textOffset = 0;
  let startColumn: number | null = null;
  let endColumn: number | null = null;
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell) continue;
    const chars = cell.getChars();
    if (!chars) continue;
    const cellEnd = textOffset + chars.length;
    if (match.start < cellEnd && match.end > textOffset) {
      startColumn ??= column;
      endColumn = column + Math.max(1, cell.getWidth());
    }
    textOffset = cellEnd;
  }
  if (startColumn === null || endColumn === null) return null;
  return { start: startColumn, end: endColumn };
}
