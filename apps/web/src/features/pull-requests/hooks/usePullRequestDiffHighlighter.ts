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

/** Builds coherent side-and-hunk blocks for only the visible virtual row window. */
export function buildPullRequestHighlightWindow(
  rows: readonly PullRequestDiffRow[],
  range: PullRequestDiffHighlightRange,
  theme: ShikiTheme,
): PullRequestDiffHighlightBlock[] {
  if (rows.length === 0 || range.endIndex < range.startIndex) return [];
  const start = Math.max(0, range.startIndex - HIGHLIGHT_CONTEXT_ROWS);
  const end = Math.min(rows.length - 1, range.endIndex + HIGHLIGHT_CONTEXT_ROWS);
  const grouped = new Map<string, PullRequestDiffHighlightBlock>();
  let sourceLineCount = 0;

  for (let index = start; index <= end; index += 1) {
    const row = rows[index];
    if (row?.kind !== "line") continue;
    const language = langFromPath(row.path);
    if (language === "text") continue;
    for (const cell of [
      getPullRequestDiffCell(row, "left"),
      getPullRequestDiffCell(row, "right"),
    ]) {
      if (cell.type === "empty" || sourceLineCount >= MAX_WINDOW_SOURCE_LINES) continue;
      const groupKey = `${row.path}:${row.hunkIndex}:${cell.side}`;
      let block = grouped.get(groupKey);
      if (!block) {
        block = {
          blockId: `pr-window:${encodeURIComponent(groupKey)}`,
          path: row.path,
          lineKeys: [],
          lines: [],
          language,
          theme,
        };
        grouped.set(groupKey, block);
      }
      block.lineKeys.push(cell.key);
      block.lines.push(cell.content);
      sourceLineCount += 1;
    }
  }

  return [...grouped.values()];
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
    [range.endIndex, range.startIndex, rows, theme],
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
      if (
        requestIdRef.current !== id ||
        workerGeneration !== generationAtRequest
      ) {
        return;
      }
      setIsPending(false);
      const result = response as PullRequestDiffTokenizeResponse | null;
      if (!result || result.type !== "tokenize-diff-window" || result.error) return;

      const bytesByPath = new Map<string, number>();
      for (const block of result.results) {
        const path = blockPaths.get(block.blockId);
        if (!path) continue;
        bytesByPath.set(path, (bytesByPath.get(path) ?? 0) + block.tokenBytes);
      }
      const acceptedPaths = new Set<string>();
      for (const [path, bytes] of bytesByPath) {
        if (onTokenBytesChangeRef.current?.(path, bytes) !== false) {
          acceptedPaths.add(path);
        } else {
          onTokenBytesChangeRef.current?.(path, 0);
        }
      }
      reportClearedPaths(acceptedPaths);

      const nextTokens = new Map<string, TokenSpan[]>();
      const nextTruncated = new Set<string>();
      let acceptedBytes = 0;
      for (const block of result.results) {
        const path = blockPaths.get(block.blockId);
        if (!path || !acceptedPaths.has(path) || block.error) continue;
        acceptedBytes += block.tokenBytes;
        for (let index = 0; index < block.lineKeys.length; index += 1) {
          const tokens = block.lines[index];
          if (tokens) nextTokens.set(block.lineKeys[index], tokens);
        }
        for (const lineKey of block.truncatedLineKeys) nextTruncated.add(lineKey);
      }
      setTokenMap(nextTokens);
      setTruncatedLineKeys(nextTruncated);
      setTokenBytes(acceptedBytes);
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
