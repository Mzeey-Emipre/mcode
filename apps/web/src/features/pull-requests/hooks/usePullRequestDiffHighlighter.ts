import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getPullRequestDiffCell,
  type PullRequestDiffRow,
} from "@/features/pull-requests/lib/pull-request-diff-row-model";
import { getWorker, nextRequestId, pending, workerGeneration } from "@/lib/shiki-worker-client";
import { langFromPath } from "@/lib/lang-from-path";
import type { ShikiTheme } from "@/hooks/useTheme";
import type {
  PullRequestDiffTokenizeBlock,
  PullRequestDiffTokenizeResponse,
  TokenSpan,
} from "@/workers/shiki.worker";

const HIGHLIGHT_CONTEXT_ROWS = 8;
const MAX_WINDOW_SOURCE_LINES = 512;

/** Inclusive virtual row range that should receive syntax tokens. */
export interface PullRequestDiffHighlightRange {
  startIndex: number;
  endIndex: number;
}

/** A worker block plus the file path that owns its token-memory budget. */
export interface PullRequestDiffHighlightBlock extends PullRequestDiffTokenizeBlock {
  path: string;
}

/** Result exposed by the visible-window pull request highlighter. */
export interface PullRequestDiffHighlightResult {
  getLineTokens: (lineKey: string) => TokenSpan[] | null;
  tokenBytes: number;
  truncatedLineKeys: ReadonlySet<string>;
  pending: boolean;
}

interface HighlightTokenState {
  tokenMap: ReadonlyMap<string, TokenSpan[]>;
  truncatedLineKeys: ReadonlySet<string>;
  tokenBytes: number;
}

function visibleHighlightRows(
  rows: readonly PullRequestDiffRow[],
  range: PullRequestDiffHighlightRange,
): readonly PullRequestDiffRow[] {
  if (rows.length === 0 || range.endIndex < range.startIndex) return [];
  const start = Math.max(0, range.startIndex - HIGHLIGHT_CONTEXT_ROWS);
  const end = Math.min(rows.length, range.endIndex + HIGHLIGHT_CONTEXT_ROWS + 1);
  return rows.slice(start, end);
}

function addHighlightCell(
  blocks: Map<string, PullRequestDiffHighlightBlock>,
  row: Extract<PullRequestDiffRow, { kind: "line" }>,
  cell: ReturnType<typeof getPullRequestDiffCell>,
  language: string,
  theme: ShikiTheme,
  sourceLineCount: number,
): number {
  if (cell.type === "empty" || sourceLineCount >= MAX_WINDOW_SOURCE_LINES)
    return sourceLineCount;
  const groupKey = `${row.path}:${row.hunkIndex}:${cell.side}`;
  let block = blocks.get(groupKey);
  if (!block) {
    block = {
      blockId: `pr-window:${encodeURIComponent(groupKey)}`,
      path: row.path,
      lineKeys: [],
      lines: [],
      language,
      theme,
    };
    blocks.set(groupKey, block);
  }
  block.lineKeys.push(cell.key);
  block.lines.push(cell.content);
  return sourceLineCount + 1;
}

function appendHighlightRow(
  blocks: Map<string, PullRequestDiffHighlightBlock>,
  row: PullRequestDiffRow,
  theme: ShikiTheme,
  sourceLineCount: number,
): number {
  if (row.kind !== "line") return sourceLineCount;
  const language = langFromPath(row.path);
  if (language === "text") return sourceLineCount;
  return [getPullRequestDiffCell(row, "left"), getPullRequestDiffCell(row, "right")].reduce(
    (count, cell) => addHighlightCell(blocks, row, cell, language, theme, count),
    sourceLineCount,
  );
}

/** Builds coherent side-and-hunk blocks for only the visible virtual row window. */
export function buildPullRequestHighlightWindow(
  rows: readonly PullRequestDiffRow[],
  range: PullRequestDiffHighlightRange,
  theme: ShikiTheme,
): PullRequestDiffHighlightBlock[] {
  const grouped = new Map<string, PullRequestDiffHighlightBlock>();
  let sourceLineCount = 0;
  for (const row of visibleHighlightRows(rows, range))
    sourceLineCount = appendHighlightRow(grouped, row, theme, sourceLineCount);
  return [...grouped.values()];
}

function currentHighlightResponse(
  requestId: string | null,
  id: string,
  generation: number,
): boolean {
  return requestId === id && workerGeneration === generation;
}

function validHighlightResponse(
  response: unknown,
): PullRequestDiffTokenizeResponse | null {
  const result = response as PullRequestDiffTokenizeResponse | null;
  return result && result.type === "tokenize-diff-window" && !result.error ? result : null;
}

function responseBytesByPath(
  result: PullRequestDiffTokenizeResponse,
  blockPaths: ReadonlyMap<string, string>,
): Map<string, number> {
  const bytesByPath = new Map<string, number>();
  for (const block of result.results) {
    const path = blockPaths.get(block.blockId);
    if (path) bytesByPath.set(path, (bytesByPath.get(path) ?? 0) + block.tokenBytes);
  }
  return bytesByPath;
}

function acceptedHighlightPaths(
  bytesByPath: ReadonlyMap<string, number>,
  onTokenBytesChange: ((path: string, bytes: number) => boolean) | undefined,
): Set<string> {
  const accepted = new Set<string>();
  for (const [path, bytes] of bytesByPath) {
    if (onTokenBytesChange?.(path, bytes) !== false) accepted.add(path);
    else onTokenBytesChange?.(path, 0);
  }
  return accepted;
}

function acceptedHighlightTokenState(
  result: PullRequestDiffTokenizeResponse,
  blockPaths: ReadonlyMap<string, string>,
  acceptedPaths: ReadonlySet<string>,
): HighlightTokenState {
  const tokenMap = new Map<string, TokenSpan[]>();
  const truncatedLineKeys = new Set<string>();
  let tokenBytes = 0;
  for (const block of result.results) {
    const path = blockPaths.get(block.blockId);
    if (!path || !acceptedPaths.has(path) || block.error) continue;
    tokenBytes += block.tokenBytes;
    block.lineKeys.forEach((lineKey, index) => {
      const tokens = block.lines[index];
      if (tokens) tokenMap.set(lineKey, tokens);
    });
    for (const lineKey of block.truncatedLineKeys) truncatedLineKeys.add(lineKey);
  }
  return { tokenMap, truncatedLineKeys, tokenBytes };
}

function blockSignature(blocks: readonly PullRequestDiffHighlightBlock[]): string {
  return blocks
    .map((block) =>
      [
        block.blockId,
        block.language,
        block.theme,
        block.lineKeys.join("\u001f"),
        block.lines.join("\u001f"),
      ].join("\u001e"),
    )
    .join("\u001d");
}

/**
 * Highlights only visible pull request hunk windows in the shared Shiki worker.
 * New windows cancel older jobs, and the caller may reject tokens that exceed
 * the owning patch entry's byte budget.
 */
export function usePullRequestDiffHighlighter(
  rows: readonly PullRequestDiffRow[],
  range: PullRequestDiffHighlightRange,
  theme: ShikiTheme,
  options: {
    enabled?: boolean;
    onTokenBytesChange?: (path: string, bytes: number) => boolean;
  } = {},
): PullRequestDiffHighlightResult {
  const enabled = options.enabled ?? true;
  const blocks = useMemo(
    () => buildPullRequestHighlightWindow(rows, range, theme),
    [range, rows, theme],
  );
  const signature = useMemo(() => blockSignature(blocks), [blocks]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const [tokenMap, setTokenMap] = useState<ReadonlyMap<string, TokenSpan[]>>(new Map());
  const [truncatedLineKeys, setTruncatedLineKeys] = useState<ReadonlySet<string>>(new Set());
  const [tokenBytes, setTokenBytes] = useState(0);
  const [isPending, setIsPending] = useState(false);
  const requestIdRef = useRef<string | null>(null);
  const reportedPathsRef = useRef<Set<string>>(new Set());
  const onTokenBytesChangeRef = useRef(options.onTokenBytesChange);
  onTokenBytesChangeRef.current = options.onTokenBytesChange;

  useEffect(() => {
    const requestBlocks = blocksRef.current;
    const reportClearedPaths = (retained: ReadonlySet<string> = new Set()): void => {
      for (const path of reportedPathsRef.current) {
        if (!retained.has(path)) onTokenBytesChangeRef.current?.(path, 0);
      }
      reportedPathsRef.current = new Set(retained);
    };

    if (!enabled || requestBlocks.length === 0) {
      // oxlint-disable-next-line react/set-state-in-effect -- A disabled worker window must immediately clear its rendered highlight result.
      setTokenMap(new Map());
      setTruncatedLineKeys(new Set());
      setTokenBytes(0);
      setIsPending(false);
      reportClearedPaths();
      return;
    }

    let worker: Worker;
    try {
      worker = getWorker();
    } catch {
      // oxlint-disable-next-line react/set-state-in-effect -- Worker availability controls whether the visible highlighting request remains pending.
      setIsPending(false);
      return;
    }

    const id = nextRequestId("pr-diff-hl");
    const generationAtRequest = workerGeneration;
    requestIdRef.current = id;
    setIsPending(true);

    const blockPaths = new Map(
      requestBlocks.map((block) => [block.blockId, block.path]),
    );
    pending.set(id, (response) => {
      if (!currentHighlightResponse(requestIdRef.current, id, generationAtRequest)) return;
      setIsPending(false);
      const result = validHighlightResponse(response);
      if (!result) return;
      const acceptedPaths = acceptedHighlightPaths(
        responseBytesByPath(result, blockPaths),
        onTokenBytesChangeRef.current,
      );
      reportClearedPaths(acceptedPaths);
      const next = acceptedHighlightTokenState(result, blockPaths, acceptedPaths);
      setTokenMap(next.tokenMap);
      setTruncatedLineKeys(next.truncatedLineKeys);
      setTokenBytes(next.tokenBytes);
    });

    worker.postMessage({
      id,
      type: "tokenize-diff-window",
      blocks: requestBlocks.map(({ path: _path, ...block }) => block),
    });

    return () => {
      pending.delete(id);
      worker.postMessage({ type: "cancel", id });
      if (requestIdRef.current === id) requestIdRef.current = null;
    };
  }, [enabled, signature]);

  useEffect(
    () => () => {
      for (const path of reportedPathsRef.current) {
        onTokenBytesChangeRef.current?.(path, 0);
      }
      reportedPathsRef.current.clear();
    },
    [],
  );

  const getLineTokens = useCallback(
    (lineKey: string) => tokenMap.get(lineKey) ?? null,
    [tokenMap],
  );

  return {
    getLineTokens,
    tokenBytes,
    truncatedLineKeys,
    pending: isPending,
  };
}
