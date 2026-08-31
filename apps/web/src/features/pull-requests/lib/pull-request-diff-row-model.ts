import {
  PULL_REQUEST_PATCH_MAX_BYTES,
  PULL_REQUEST_PATCH_MAX_LINES,
  PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
  type PullRequestFile,
  type PullRequestPatchResult,
  type PullRequestReviewThread,
} from "@mcode/contracts";
import {
  getPullRequestCoordinateKey,
  getPullRequestThreadCoordinate,
  type PullRequestDiffCoordinate,
} from "./pull-request-diff-coordinates";
import { parseDiffLines, type ParsedDiffLine } from "@/lib/diff-parser";

/** Patch states the viewport can represent without assuming a successful response. */
export type PullRequestDiffPatchState =
  | "idle"
  | "loading"
  | "error"
  | "evicted"
  | "available"
  | "generated"
  | "binary"
  | "unavailable"
  | "too_large";

/** The local-draft fields required for stable placement inside the row model. */
export interface PullRequestDiffDraftLike {
  localId: string;
  path: string;
  coordinate: PullRequestDiffCoordinate | null;
  outdated: boolean;
}

/** One file and its independently loaded data used to build the virtual row sequence. */
export interface PullRequestDiffFileInput {
  file: PullRequestFile;
  expanded: boolean;
  patchState: PullRequestDiffPatchState;
  patchResult: PullRequestPatchResult | null;
  errorMessage?: string | null;
  threads: readonly PullRequestReviewThread[];
  drafts: readonly PullRequestDiffDraftLike[];
}

/** A file header in the row-major diff surface. */
export interface PullRequestDiffFileRow {
  kind: "file";
  key: string;
  snapshotKey: string;
  file: PullRequestFile;
  expanded: boolean;
  patchState: PullRequestDiffPatchState;
  threadCount: number;
  draftCount: number;
}

/** A stable hunk boundary used by keyboard navigation. */
export interface PullRequestDiffHunkRow {
  kind: "hunk";
  key: string;
  snapshotKey: string;
  path: string;
  hunkIndex: number;
  label: string;
  hiddenLineCount: number;
}

/** One old- or new-file cell inside the shared row-major model. */
export interface PullRequestDiffCell {
  key: string;
  side: "left" | "right";
  type: "remove" | "add" | "context" | "metadata" | "empty";
  content: string;
  lineNumber: number | null;
  hunkIndex: number;
}

/** One physical row rendered as stacked unified cells or paired split cells. */
export interface PullRequestDiffLineRow {
  kind: "line";
  key: string;
  path: string;
  hunkIndex: number;
  leftType: PullRequestDiffCell["type"];
  leftContent: string;
  leftLineNumber: number | null;
  rightType: PullRequestDiffCell["type"];
  rightContent: string;
  rightLineNumber: number | null;
}

/** Existing threads and local drafts attached after an exact or fallback row. */
export interface PullRequestDiffInlineRow {
  kind: "inline";
  key: string;
  snapshotKey: string;
  path: string;
  coordinate: PullRequestDiffCoordinate | null;
  placement: "file" | "current" | "original" | "outdated";
  anchorLineKey: string | null;
  threads: readonly PullRequestReviewThread[];
  drafts: readonly PullRequestDiffDraftLike[];
}

/** A bounded non-code state such as loading, binary, unavailable, or too large. */
export interface PullRequestDiffNoticeRow {
  kind: "notice";
  key: string;
  snapshotKey: string;
  path: string;
  state: Exclude<PullRequestDiffPatchState, "available" | "generated"> | "empty";
  message: string;
}

/** One item measured by the shared unified/split virtualizer. */
export type PullRequestDiffRow =
  | PullRequestDiffFileRow
  | PullRequestDiffHunkRow
  | PullRequestDiffLineRow
  | PullRequestDiffInlineRow
  | PullRequestDiffNoticeRow;

/** Result of preflighting and parsing one remote patch. */
export type PullRequestPatchParseResult =
  | {
      ok: true;
      lines: ParsedDiffLine[];
      sourceBytes: number;
      parsedBytes: number;
    }
  | {
      ok: false;
      reason: "byte_limit" | "line_limit" | "line_length" | "line_count_mismatch";
      sourceBytes: number;
    };

/** The complete row sequence plus per-patch derived-memory accounting. */
export interface PullRequestDiffRowModel {
  rows: PullRequestDiffRow[];
  parsedBytesByLocator: ReadonlyMap<string, number>;
  rejectedPatchLocators: ReadonlySet<string>;
  deferredPatchLocators: ReadonlySet<string>;
}

/** Outdated conversations whose file is no longer present in the active snapshot. */
export interface PullRequestOrphanConversationInput {
  snapshotKey: string;
  threads: readonly PullRequestReviewThread[];
  drafts: readonly PullRequestDiffDraftLike[];
}

const TEXT_ENCODER = new TextEncoder();

function scanPatchLines(patch: string): {
  lineCount: number;
  hasOversizedLine: boolean;
} {
  if (patch.length === 0) return { lineCount: 0, hasOversizedLine: false };
  let lineCount = 1;
  let lineBytes = 0;
  let hasOversizedLine = false;
  for (const character of patch) {
    if (character === "\n") {
      lineCount += 1;
      lineBytes = 0;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    lineBytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (lineBytes > PULL_REQUEST_PATCH_MAX_LINE_LENGTH) {
      hasOversizedLine = true;
    }
  }
  if (patch.endsWith("\n")) lineCount -= 1;
  return { lineCount, hasOversizedLine };
}

function estimateParsedBytes(lines: readonly ParsedDiffLine[]): number {
  let bytes = 0;
  for (const line of lines) {
    bytes += line.content.length * 2 + 620;
  }
  return bytes;
}

function compactToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Rejects over-budget or malformed patches before the existing parser is called. */
export function parseBoundedPullRequestPatch(
  patch: string,
  declaredLineCount?: number | null,
): PullRequestPatchParseResult {
  const sourceBytes = TEXT_ENCODER.encode(patch).byteLength;
  if (sourceBytes > PULL_REQUEST_PATCH_MAX_BYTES) {
    return { ok: false, reason: "byte_limit", sourceBytes };
  }
  const scan = scanPatchLines(patch);
  if (scan.hasOversizedLine) {
    return { ok: false, reason: "line_length", sourceBytes };
  }
  if (scan.lineCount > PULL_REQUEST_PATCH_MAX_LINES) {
    return { ok: false, reason: "line_limit", sourceBytes };
  }
  if (declaredLineCount !== null && declaredLineCount !== undefined) {
    if (scan.lineCount !== declaredLineCount) {
      return { ok: false, reason: "line_count_mismatch", sourceBytes };
    }
  }
  const lines = parseDiffLines(patch);
  return {
    ok: true,
    lines,
    sourceBytes,
    parsedBytes: estimateParsedBytes(lines),
  };
}

function stablePart(value: string | number | null): string {
  return value === null ? "~" : encodeURIComponent(String(value));
}

function emptyCell(
  fileToken: string,
  hunkIndex: number,
  side: "left" | "right",
  ordinal: number,
): PullRequestDiffCell {
  return {
    key: `pr-c:${fileToken}:${hunkIndex}:${ordinal}:${side}:empty`,
    side,
    type: "empty",
    content: "",
    lineNumber: null,
    hunkIndex,
  };
}

function cellFromLine(
  fileToken: string,
  hunkIndex: number,
  side: "left" | "right",
  line: ParsedDiffLine,
  ordinal: number,
): PullRequestDiffCell {
  const type = line.isNoNewlineSentinel
    ? "metadata"
    : line.type === "remove"
      ? "remove"
      : line.type === "add"
        ? "add"
        : "context";
  const lineNumber = side === "left" ? line.oldLineNo : line.newLineNo;
  return {
    key: `pr-c:${fileToken}:${hunkIndex}:${ordinal}:${side}:${type}`,
    side,
    type,
    content: line.content,
    lineNumber,
    hunkIndex,
  };
}

function lineRow(
  path: string,
  fileToken: string,
  hunkIndex: number,
  ordinal: number,
  left: PullRequestDiffCell,
  right: PullRequestDiffCell,
): PullRequestDiffLineRow {
  return {
    kind: "line",
    key: `pr-l:${fileToken}:${hunkIndex}:${ordinal}`,
    path,
    hunkIndex,
    leftType: left.type,
    leftContent: left.content,
    leftLineNumber: left.lineNumber,
    rightType: right.type,
    rightContent: right.content,
    rightLineNumber: right.lineNumber,
  };
}

/** Returns one stable cell key without retaining a second key per diff side. */
export function getPullRequestDiffCellKey(
  row: PullRequestDiffLineRow,
  side: "left" | "right",
): string {
  const type = side === "left" ? row.leftType : row.rightType;
  return `pr-c:${row.key.slice("pr-l:".length)}:${side}:${type}`;
}

/** Materializes one visible side of a compact retained line row. */
export function getPullRequestDiffCell(
  row: PullRequestDiffLineRow,
  side: "left" | "right",
): PullRequestDiffCell {
  if (side === "left") {
    return {
      key: getPullRequestDiffCellKey(row, side),
      side,
      type: row.leftType,
      content: row.leftContent,
      lineNumber: row.leftLineNumber,
      hunkIndex: row.hunkIndex,
    };
  }
  return {
    key: getPullRequestDiffCellKey(row, side),
    side,
    type: row.rightType,
    content: row.rightContent,
    lineNumber: row.rightLineNumber,
    hunkIndex: row.hunkIndex,
  };
}

interface PatchRowBuilder {
  rows: Array<PullRequestDiffHunkRow | PullRequestDiffLineRow>;
  hunkIndex: number;
  pairOrdinal: number;
  index: number;
}

function appendPatchHunk(
  builder: PatchRowBuilder,
  snapshotToken: string,
  path: string,
  fileToken: string,
  line: ParsedDiffLine,
): void {
  if (line.content.startsWith("@@")) {
    builder.hunkIndex += 1;
    builder.pairOrdinal = 0;
    builder.rows.push({
      kind: "hunk",
      key: `pr-h:${fileToken}:${builder.hunkIndex}`,
      snapshotKey: snapshotToken,
      path,
      hunkIndex: builder.hunkIndex,
      label: line.content,
      hiddenLineCount: line.hiddenLineCount ?? 0,
    });
  }
  builder.index += 1;
}

function appendPatchLine(
  builder: PatchRowBuilder,
  path: string,
  fileToken: string,
  left: PullRequestDiffCell,
  right: PullRequestDiffCell,
): void {
  builder.rows.push(lineRow(path, fileToken, builder.hunkIndex, builder.pairOrdinal, left, right));
  builder.pairOrdinal += 1;
}

function appendRemovalRun(
  builder: PatchRowBuilder,
  path: string,
  fileToken: string,
  lines: readonly ParsedDiffLine[],
): void {
  const removals: ParsedDiffLine[] = [];
  const additions: ParsedDiffLine[] = [];
  while (builder.index < lines.length && lines[builder.index]?.type === "remove") {
    removals.push(lines[builder.index]!);
    builder.index += 1;
  }
  while (builder.index < lines.length && lines[builder.index]?.type === "add") {
    additions.push(lines[builder.index]!);
    builder.index += 1;
  }
  for (let offset = 0; offset < Math.max(removals.length, additions.length); offset += 1) {
    const left = removals[offset]
      ? cellFromLine(fileToken, builder.hunkIndex, "left", removals[offset], builder.pairOrdinal)
      : emptyCell(fileToken, builder.hunkIndex, "left", builder.pairOrdinal);
    const right = additions[offset]
      ? cellFromLine(fileToken, builder.hunkIndex, "right", additions[offset], builder.pairOrdinal)
      : emptyCell(fileToken, builder.hunkIndex, "right", builder.pairOrdinal);
    appendPatchLine(builder, path, fileToken, left, right);
  }
}

function appendSinglePatchLine(
  builder: PatchRowBuilder,
  path: string,
  fileToken: string,
  line: ParsedDiffLine,
): void {
  const left = line.type === "add"
    ? emptyCell(fileToken, builder.hunkIndex, "left", builder.pairOrdinal)
    : cellFromLine(fileToken, builder.hunkIndex, "left", line, builder.pairOrdinal);
  const right = line.type === "add"
    ? cellFromLine(fileToken, builder.hunkIndex, "right", line, builder.pairOrdinal)
    : cellFromLine(fileToken, builder.hunkIndex, "right", line, builder.pairOrdinal);
  appendPatchLine(builder, path, fileToken, left, right);
  builder.index += 1;
}

function appendPatchRow(
  builder: PatchRowBuilder,
  snapshotToken: string,
  path: string,
  fileToken: string,
  lines: readonly ParsedDiffLine[],
): void {
  const current = lines[builder.index]!;
  if (current.type === "header") return appendPatchHunk(builder, snapshotToken, path, fileToken, current);
  if (builder.hunkIndex < 0) builder.hunkIndex = 0;
  if (current.type === "remove") return appendRemovalRun(builder, path, fileToken, lines);
  appendSinglePatchLine(builder, path, fileToken, current);
}

function buildPatchRows(
  snapshotToken: string,
  path: string,
  fileToken: string,
  lines: readonly ParsedDiffLine[],
): Array<PullRequestDiffHunkRow | PullRequestDiffLineRow> {
  const builder: PatchRowBuilder = { rows: [], hunkIndex: -1, pairOrdinal: 0, index: 0 };
  while (builder.index < lines.length) appendPatchRow(builder, snapshotToken, path, fileToken, lines);
  return builder.rows;
}

interface IndexedLineAnchor {
  rowKey: string;
  cellKey: string;
}

function indexLineAnchor(
  index: Map<string, IndexedLineAnchor>,
  requestedKeys: ReadonlySet<string>,
  row: PullRequestDiffLineRow,
  side: "left" | "right",
): void {
  const lineNumber = side === "left" ? row.leftLineNumber : row.rightLineNumber;
  const type = side === "left" ? row.leftType : row.rightType;
  if (lineNumber === null || type === "empty") return;
  const key = `${side}:${lineNumber}`;
  if (requestedKeys.has(key) && !index.has(key)) {
    index.set(key, { rowKey: row.key, cellKey: getPullRequestDiffCellKey(row, side) });
  }
}

function indexLineRowAnchors(
  index: Map<string, IndexedLineAnchor>,
  requestedKeys: ReadonlySet<string>,
  row: PullRequestDiffRow,
): void {
  if (row.kind !== "line") return;
  indexLineAnchor(index, requestedKeys, row, "left");
  indexLineAnchor(index, requestedKeys, row, "right");
}

function lineAnchorIndex(
  rows: readonly PullRequestDiffRow[],
  requestedKeys: ReadonlySet<string>,
): ReadonlyMap<string, IndexedLineAnchor> {
  const index = new Map<string, IndexedLineAnchor>();
  if (requestedKeys.size === 0) return index;
  for (const row of rows) {
    indexLineRowAnchors(index, requestedKeys, row);
    if (index.size === requestedKeys.size) break;
  }
  return index;
}

function addRequestedLineAnchorKeys(
  keys: Set<string>,
  coordinate: PullRequestDiffCoordinate,
): void {
  if (coordinate.subjectType === "file") return;
  if (coordinate.line !== null) {
    keys.add(`${coordinate.side ?? "right"}:${coordinate.line}`);
  }
  if (coordinate.originalLine !== null) {
    keys.add(
      `${coordinate.originalSide ?? coordinate.side ?? "left"}:${coordinate.originalLine}`,
    );
  }
}

function findThreadAnchor(
  index: ReadonlyMap<string, IndexedLineAnchor>,
  coordinate: PullRequestDiffCoordinate,
): { rowKey: string; cellKey: string; placement: "current" | "original" } | null {
  if (coordinate.subjectType === "file") return null;
  if (coordinate.line !== null) {
    const current = index.get(`${coordinate.side ?? "right"}:${coordinate.line}`);
    if (current) return { ...current, placement: "current" };
  }
  if (coordinate.originalLine !== null) {
    const original = index.get(
      `${coordinate.originalSide ?? coordinate.side ?? "left"}:${coordinate.originalLine}`,
    );
    if (original) return { ...original, placement: "original" };
  }
  return null;
}

interface InlinePlacement {
  afterKey: string | null;
  row: PullRequestDiffInlineRow;
}

type InlineContent =
  | {
      kind: "thread";
      stableId: string;
      coordinate: PullRequestDiffCoordinate | null;
      outdated: boolean;
      headOid: string;
      value: PullRequestReviewThread;
    }
  | {
      kind: "draft";
      stableId: string;
      coordinate: PullRequestDiffCoordinate | null;
      outdated: boolean;
      headOid: string | null;
      value: PullRequestDiffDraftLike;
    };

interface InlinePlacementContext {
  snapshotKey: string;
  snapshotToken: string;
  path: string;
  fileRowKey: string;
  grouped: Map<string, InlinePlacement>;
}

function inlineContents(
  threads: readonly PullRequestReviewThread[],
  drafts: readonly PullRequestDiffDraftLike[],
): InlineContent[] {
  return [
    ...threads.map((thread) => ({
      kind: "thread" as const,
      stableId: thread.providerNodeId,
      coordinate: getPullRequestThreadCoordinate(thread),
      outdated: thread.isOutdated,
      headOid: thread.headOid,
      value: thread,
    })),
    ...drafts.map((draft) => ({
      kind: "draft" as const,
      stableId: draft.localId,
      coordinate: draft.coordinate,
      outdated: draft.outdated,
      headOid: draft.coordinate?.headOid ?? null,
      value: draft,
    })),
  ];
}

function hasCurrentAnchor(content: InlineContent, headOid: string): boolean {
  return content.coordinate !== null && !content.outdated && content.headOid === headOid;
}

function addCurrentAnchorKey(
  keys: Set<string>,
  content: InlineContent,
  headOid: string,
): void {
  if (hasCurrentAnchor(content, headOid)) addRequestedLineAnchorKeys(keys, content.coordinate!);
}

function ensureInlinePlacement(
  context: InlinePlacementContext,
  coordinate: PullRequestDiffCoordinate | null,
  placement: PullRequestDiffInlineRow["placement"],
  afterKey: string | null,
  anchorLineKey: string | null,
  stableId: string,
): InlinePlacement {
  const coordinateKey = coordinate
    ? getPullRequestCoordinateKey(context.snapshotKey, context.path, coordinate)
    : `file:${stablePart(context.snapshotKey)}:${stablePart(context.path)}`;
  const groupKey = `${placement}:${afterKey ?? "tail"}:${coordinateKey}`;
  const existing = context.grouped.get(groupKey);
  if (existing) return existing;
  const next: InlinePlacement = {
    afterKey,
    row: {
      kind: "inline",
      key: `pr-inline:${groupKey}:${stablePart(stableId)}`,
      snapshotKey: context.snapshotToken,
      path: context.path,
      coordinate,
      placement,
      anchorLineKey,
      threads: [],
      drafts: [],
    },
  };
  context.grouped.set(groupKey, next);
  return next;
}

function inlinePlacementForContent(
  context: InlinePlacementContext,
  anchorIndex: ReadonlyMap<string, IndexedLineAnchor>,
  content: InlineContent,
  headOid: string,
): InlinePlacement {
  const coordinate = content.coordinate;
  if (coordinate === null || coordinate.subjectType === "file") {
    return ensureInlinePlacement(context, coordinate, "file", context.fileRowKey, null, content.stableId);
  }
  const exact = hasCurrentAnchor(content, headOid)
    ? findThreadAnchor(anchorIndex, coordinate)
    : null;
  return exact
    ? ensureInlinePlacement(context, coordinate, exact.placement, exact.rowKey, exact.cellKey, content.stableId)
    : ensureInlinePlacement(context, coordinate, "outdated", null, null, content.stableId);
}

function attachInlineContent(placement: InlinePlacement, content: InlineContent): void {
  if (content.kind === "thread") {
    placement.row = { ...placement.row, threads: [...placement.row.threads, content.value] };
    return;
  }
  placement.row = { ...placement.row, drafts: [...placement.row.drafts, content.value] };
}

function buildInlinePlacements(
  snapshotKey: string,
  snapshotToken: string,
  headOid: string,
  path: string,
  anchorRows: readonly PullRequestDiffRow[],
  fileRowKey: string,
  threads: readonly PullRequestReviewThread[],
  drafts: readonly PullRequestDiffDraftLike[],
): InlinePlacement[] {
  const contents = inlineContents(threads, drafts);
  const requestedAnchorKeys = new Set<string>();
  for (const content of contents) addCurrentAnchorKey(requestedAnchorKeys, content, headOid);
  const anchorIndex = lineAnchorIndex(anchorRows, requestedAnchorKeys);
  const context: InlinePlacementContext = {
    snapshotKey,
    snapshotToken,
    path,
    fileRowKey,
    grouped: new Map(),
  };
  for (const content of contents) {
    attachInlineContent(inlinePlacementForContent(context, anchorIndex, content, headOid), content);
  }
  return [...context.grouped.values()];
}

function insertInlinePlacements(
  rows: readonly PullRequestDiffRow[],
  placements: readonly InlinePlacement[],
): PullRequestDiffRow[] {
  if (placements.length === 0) return [...rows];
  const after = new Map<string, PullRequestDiffInlineRow[]>();
  const tail: PullRequestDiffInlineRow[] = [];
  for (const placement of placements) {
    if (placement.afterKey === null) {
      tail.push(placement.row);
      continue;
    }
    const entries = after.get(placement.afterKey) ?? [];
    entries.push(placement.row);
    after.set(placement.afterKey, entries);
  }
  const merged: PullRequestDiffRow[] = [];
  for (const row of rows) {
    merged.push(row);
    merged.push(...(after.get(row.key) ?? []));
  }
  merged.push(...tail);
  return merged;
}

function noticeMessage(
  state: PullRequestDiffNoticeRow["state"],
  errorMessage?: string | null,
): string {
  switch (state) {
    case "idle":
      return "Patch not loaded";
    case "loading":
      return "Loading patch";
    case "error":
      return errorMessage || "Patch unavailable";
    case "evicted":
      return "Patch unloaded to stay within the review memory limit.";
    case "binary":
      return "Binary file. Text diff unavailable.";
    case "unavailable":
      return "Provider did not return a text patch.";
    case "too_large":
      return "Patch exceeds the review limit.";
    case "empty":
      return "No changed lines in this patch.";
  }
}

type CachedPatchRow = PullRequestDiffHunkRow | PullRequestDiffLineRow | PullRequestDiffNoticeRow;

interface CachedPatchRows {
  rows: readonly CachedPatchRow[];
  parsedBytes: number;
  rejected: boolean;
  deferred: boolean;
}

type AvailablePatchResult = Extract<PullRequestPatchResult, { ok: true }> & {
  status: "available" | "generated";
  patch: string;
  parsedLineCount: number;
};

const PATCH_ROW_CACHE = new WeakMap<object, CachedPatchRows>();

function retainedPatchRowsBytes(rows: readonly CachedPatchRow[]): number {
  let bytes = rows.length * 8;
  const firstRow = rows[0];
  if (firstRow) {
    bytes += firstRow.path.length * 2;
    if ("snapshotKey" in firstRow) bytes += firstRow.snapshotKey.length * 2;
  }
  for (const row of rows) {
    if (row.kind === "line") {
      bytes +=
        352 +
        (
          row.key.length +
          row.leftContent.length +
          row.rightContent.length
        ) * 2;
    } else if (row.kind === "hunk") {
      bytes += 192 + (row.key.length + row.label.length) * 2;
    } else {
      bytes += 192 + (row.key.length + row.message.length) * 2;
    }
  }
  return bytes;
}

function budgetRejectedPatchRows(
  snapshotToken: string,
  fileToken: string,
  path: string,
): CachedPatchRows {
  return {
    rows: [{
      kind: "notice",
      key: `pr-n:${fileToken}:rejected:memory_budget`,
      snapshotKey: snapshotToken,
      path,
      state: "too_large",
      message: noticeMessage("too_large"),
    }],
    parsedBytes: 0,
    rejected: true,
    deferred: false,
  };
}

function budgetDeferredPatchRows(
  snapshotToken: string,
  fileToken: string,
  path: string,
  parsedBytes: number,
): CachedPatchRows {
  return {
    rows: [{
      kind: "notice",
      key: `pr-n:${fileToken}:deferred:memory_budget`,
      snapshotKey: snapshotToken,
      path,
      state: "loading",
      message: "Releasing older patch data before loading this diff.",
    }],
    parsedBytes,
    rejected: false,
    deferred: true,
  };
}

function cachedRowsWithinBudget(
  cached: CachedPatchRows,
  maxParsedBytes: number,
  intrinsicMaxParsedBytes: number,
): boolean {
  return cached.parsedBytes <= maxParsedBytes && cached.parsedBytes <= intrinsicMaxParsedBytes;
}

function boundedCachedRows(
  snapshotToken: string,
  fileToken: string,
  path: string,
  cached: CachedPatchRows,
  intrinsicMaxParsedBytes: number,
): CachedPatchRows {
  return cached.parsedBytes > intrinsicMaxParsedBytes
    ? budgetRejectedPatchRows(snapshotToken, fileToken, path)
    : budgetDeferredPatchRows(snapshotToken, fileToken, path, cached.parsedBytes);
}

function parseFailurePatchRows(
  snapshotToken: string,
  fileToken: string,
  path: string,
  reason: Extract<PullRequestPatchParseResult, { ok: false }>['reason'],
  maxParsedBytes: number,
): CachedPatchRows {
  const rows: CachedPatchRow[] = [{
    kind: "notice",
    key: `pr-n:${fileToken}:rejected:${reason}`,
    snapshotKey: snapshotToken,
    path,
    state: "too_large",
    message: noticeMessage("too_large"),
  }];
  const built: CachedPatchRows = {
    rows,
    parsedBytes: retainedPatchRowsBytes(rows),
    rejected: true,
    deferred: false,
  };
  return built.parsedBytes > maxParsedBytes
    ? budgetRejectedPatchRows(snapshotToken, fileToken, path)
    : built;
}

function parsedPatchRows(
  snapshotToken: string,
  fileToken: string,
  file: PullRequestFile,
  parsed: Extract<PullRequestPatchParseResult, { ok: true }>,
  maxParsedBytes: number,
  intrinsicMaxParsedBytes: number,
): CachedPatchRows {
  if (parsed.parsedBytes > intrinsicMaxParsedBytes)
    return budgetRejectedPatchRows(snapshotToken, fileToken, file.path);
  if (parsed.parsedBytes > maxParsedBytes)
    return budgetDeferredPatchRows(snapshotToken, fileToken, file.path, parsed.parsedBytes);
  const rows: CachedPatchRow[] = buildPatchRows(snapshotToken, file.path, fileToken, parsed.lines);
  if (rows.length === 0) {
    rows.push({
      kind: "notice",
      key: `pr-n:${fileToken}:empty`,
      snapshotKey: snapshotToken,
      path: file.path,
      state: "empty",
      message: noticeMessage("empty"),
    });
  }
  const parsedBytes = retainedPatchRowsBytes(rows);
  if (parsedBytes > intrinsicMaxParsedBytes)
    return budgetRejectedPatchRows(snapshotToken, fileToken, file.path);
  if (parsedBytes > maxParsedBytes)
    return budgetDeferredPatchRows(snapshotToken, fileToken, file.path, parsedBytes);
  return { rows, parsedBytes, rejected: false, deferred: false };
}

function builtPatchRows(
  snapshotToken: string,
  fileToken: string,
  file: PullRequestFile,
  result: AvailablePatchResult,
  maxParsedBytes: number,
  intrinsicMaxParsedBytes: number,
): CachedPatchRows {
  const parsed = parseBoundedPullRequestPatch(result.patch, result.parsedLineCount);
  return parsed.ok
    ? parsedPatchRows(snapshotToken, fileToken, file, parsed, maxParsedBytes, intrinsicMaxParsedBytes)
    : parseFailurePatchRows(snapshotToken, fileToken, file.path, parsed.reason, maxParsedBytes);
}

function cachedPatchRows(
  snapshotToken: string,
  fileToken: string,
  file: PullRequestFile,
  result: AvailablePatchResult,
  maxParsedBytes: number,
  intrinsicMaxParsedBytes: number,
): CachedPatchRows {
  const cached = PATCH_ROW_CACHE.get(result);
  if (cached) {
    if (cachedRowsWithinBudget(cached, maxParsedBytes, intrinsicMaxParsedBytes)) return cached;
    PATCH_ROW_CACHE.delete(result);
    return boundedCachedRows(snapshotToken, fileToken, file.path, cached, intrinsicMaxParsedBytes);
  }
  const built = builtPatchRows(
    snapshotToken,
    fileToken,
    file,
    result,
    maxParsedBytes,
    intrinsicMaxParsedBytes,
  );
  PATCH_ROW_CACHE.set(result, built);
  return built;
}

/** Releases cached immutable rows when their store accounting is cleared. */
export function releasePullRequestPatchRows(result: PullRequestPatchResult | null): void {
  if (result?.ok) PATCH_ROW_CACHE.delete(result);
}

function patchFileToken(snapshotKey: string, file: PullRequestFile): string {
  const snapshotToken = compactToken(snapshotKey);
  return [
    snapshotToken,
    compactToken(`${file.locator}\0${file.path}`),
    compactToken(`${file.path}\0${file.locator}`),
  ].join(":");
}

function patchFileRow(
  snapshotToken: string,
  fileToken: string,
  input: PullRequestDiffFileInput,
): PullRequestDiffFileRow {
  return {
    kind: "file",
    key: `pr-f:${fileToken}`,
    snapshotKey: snapshotToken,
    file: input.file,
    expanded: input.expanded,
    patchState: input.patchState,
    threadCount: input.threads.length,
    draftCount: input.drafts.length,
  };
}

function isAvailablePatchResult(
  result: PullRequestPatchResult | null,
): result is AvailablePatchResult {
  return result?.ok === true && (result.status === "available" || result.status === "generated");
}

function noticePatchState(input: PullRequestDiffFileInput): PullRequestDiffNoticeRow["state"] {
  const state = input.patchResult?.ok === true ? input.patchResult.status : input.patchState;
  return state === "available" || state === "generated" ? "error" : state;
}

function patchRowsForFile(
  snapshotToken: string,
  fileToken: string,
  input: PullRequestDiffFileInput,
  maxParsedBytes: number,
  intrinsicMaxParsedBytes: number,
): CachedPatchRows {
  if (isAvailablePatchResult(input.patchResult)) {
    return cachedPatchRows(
      snapshotToken,
      fileToken,
      input.file,
      input.patchResult,
      maxParsedBytes,
      intrinsicMaxParsedBytes,
    );
  }
  const state = noticePatchState(input);
  return {
    rows: [{
      kind: "notice",
      key: `pr-n:${fileToken}:state:${state}`,
      snapshotKey: snapshotToken,
      path: input.file.path,
      state,
      message: noticeMessage(state, input.errorMessage),
    }],
    parsedBytes: 0,
    rejected: false,
    deferred: false,
  };
}

function buildFileRows(
  snapshotKey: string,
  headOid: string,
  input: PullRequestDiffFileInput,
  maxParsedBytes: number,
  intrinsicMaxParsedBytes: number,
): {
  rows: PullRequestDiffRow[];
  parsedBytes: number;
  rejected: boolean;
  deferred: boolean;
} {
  const { file } = input;
  const snapshotToken = compactToken(snapshotKey);
  const fileToken = patchFileToken(snapshotKey, file);
  const fileRow = patchFileRow(snapshotToken, fileToken, input);
  if (!input.expanded) {
    return { rows: [fileRow], parsedBytes: 0, rejected: false, deferred: false };
  }
  const patchRows = patchRowsForFile(
    snapshotToken,
    fileToken,
    input,
    maxParsedBytes,
    intrinsicMaxParsedBytes,
  );
  const placements = buildInlinePlacements(
    snapshotKey,
    snapshotToken,
    headOid,
    file.path,
    patchRows.rows,
    fileRow.key,
    input.threads,
    input.drafts,
  );
  const rows = insertInlinePlacements([fileRow, ...patchRows.rows], placements);
  return { ...patchRows, rows };
}

function fileBudget(
  input: Parameters<typeof buildPullRequestDiffRowModel>[0],
  file: PullRequestDiffFileInput,
  parsedByteBudget: number,
): { reservedBytes: number; maxParsedBytes: number; intrinsicMaxParsedBytes: number } {
  const reservedBytes = Math.max(0, input.reservedParsedBytesByLocator?.get(file.file.locator) ?? 0);
  return {
    reservedBytes,
    maxParsedBytes: reservedBytes + parsedByteBudget,
    intrinsicMaxParsedBytes: Math.max(
      0,
      input.intrinsicParsedBytesByLocator?.get(file.file.locator) ?? Number.POSITIVE_INFINITY,
    ),
  };
}

function remainingParsedBudget(
  parsedByteBudget: number,
  built: ReturnType<typeof buildFileRows>,
  reservedBytes: number,
): number {
  if (built.rejected || built.deferred) return parsedByteBudget;
  return parsedByteBudget - Math.max(0, built.parsedBytes - reservedBytes);
}

/** Builds the stable, row-major sequence consumed by both unified and split views. */
export function buildPullRequestDiffRowModel(input: {
  snapshotKey: string;
  headOid: string;
  files: readonly PullRequestDiffFileInput[];
  parsedByteBudget?: number;
  reservedParsedBytesByLocator?: ReadonlyMap<string, number>;
  intrinsicParsedBytesByLocator?: ReadonlyMap<string, number>;
}): PullRequestDiffRowModel {
  const rows: PullRequestDiffRow[] = [];
  const parsedBytesByLocator = new Map<string, number>();
  const rejectedPatchLocators = new Set<string>();
  const deferredPatchLocators = new Set<string>();
  let parsedByteBudget = Math.max(0, input.parsedByteBudget ?? Number.POSITIVE_INFINITY);
  for (const file of input.files) {
    const budget = fileBudget(input, file, parsedByteBudget);
    const built = buildFileRows(
      input.snapshotKey,
      input.headOid,
      file,
      budget.maxParsedBytes,
      budget.intrinsicMaxParsedBytes,
    );
    rows.push(...built.rows);
    parsedBytesByLocator.set(file.file.locator, built.parsedBytes);
    if (built.rejected) rejectedPatchLocators.add(file.file.locator);
    if (built.deferred) deferredPatchLocators.add(file.file.locator);
    parsedByteBudget = remainingParsedBudget(parsedByteBudget, built, budget.reservedBytes);
  }
  return {
    rows,
    parsedBytesByLocator,
    rejectedPatchLocators,
    deferredPatchLocators,
  };
}

/** Builds visible tail rows for outdated conversations on removed files. */
export function buildPullRequestOrphanConversationRows(
  input: PullRequestOrphanConversationInput,
): PullRequestDiffInlineRow[] {
  const byPath = new Map<
    string,
    {
      threads: PullRequestReviewThread[];
      drafts: PullRequestDiffDraftLike[];
    }
  >();
  for (const thread of input.threads) {
    const group = byPath.get(thread.path) ?? { threads: [], drafts: [] };
    group.threads.push(thread);
    byPath.set(thread.path, group);
  }
  for (const draft of input.drafts) {
    const group = byPath.get(draft.path) ?? { threads: [], drafts: [] };
    group.drafts.push(draft);
    byPath.set(draft.path, group);
  }
  return [...byPath.entries()].map(([path, group]) => ({
    kind: "inline",
    key: `pr-inline:orphan:${stablePart(input.snapshotKey)}:${stablePart(path)}`,
    snapshotKey: input.snapshotKey,
    path,
    coordinate: null,
    placement: "outdated",
    anchorLineKey: null,
    threads: group.threads,
    drafts: group.drafts,
  }));
}

/** Returns the stable cell keys that can participate in roving line focus. */
export function getPullRequestFocusableCellKeys(
  rows: readonly PullRequestDiffRow[],
  mode: "unified" | "split",
): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (row.kind !== "line") continue;
    if (mode === "unified") {
      if (row.leftType === "remove" || row.leftType === "metadata") {
        keys.push(getPullRequestDiffCellKey(row, "left"));
      }
      if (row.rightType !== "empty") keys.push(getPullRequestDiffCellKey(row, "right"));
      else if (row.leftType === "context") {
        keys.push(getPullRequestDiffCellKey(row, "left"));
      }
      continue;
    }
    if (row.leftType !== "empty") keys.push(getPullRequestDiffCellKey(row, "left"));
    if (row.rightType !== "empty") keys.push(getPullRequestDiffCellKey(row, "right"));
  }
  return keys;
}

/** Returns each hunk's first focusable cell for J and K navigation. */
export function getPullRequestHunkTargets(
  rows: readonly PullRequestDiffRow[],
  mode: "unified" | "split",
): Array<{ hunkIndex: number; rowIndex: number; cellKey: string }> {
  const targets: Array<{ hunkIndex: number; rowIndex: number; cellKey: string }> = [];
  const seen = new Set<string>();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.kind !== "line") continue;
    const identity = `${row.path}:${row.hunkIndex}`;
    if (seen.has(identity)) continue;
    const key = getPullRequestFocusableCellKeys([row], mode)[0];
    if (!key) continue;
    seen.add(identity);
    targets.push({ hunkIndex: row.hunkIndex, rowIndex, cellKey: key });
  }
  return targets;
}
