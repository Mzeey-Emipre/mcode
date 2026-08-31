import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedDiffLine } from "@/lib/diff-parser";
import type { ShikiTheme } from "./useTheme";
import type { TokenSpan } from "@/workers/shiki.worker";
import { getWorker, workerGeneration, pending, nextRequestId } from "@/lib/shiki-worker-client";

/** Response from the worker for a tokenize request. */
interface TokenizeResponse {
  id: string;
  type: "tokenize";
  results: Array<{
    blockId: string;
    lines: TokenSpan[][];
    error?: string;
  }>;
}

/** Locates a diff line's tokens within a specific worker block. */
interface BlockRef {
  /** Worker block identifier (e.g. "old:0", "new:1"). */
  blockId: string;
  /** Zero-based line index within that block. */
  lineIdx: number;
}

interface DiffHighlightBlocks {
  blocks: Array<{ blockId: string; code: string }>;
  oldIndexMap: Map<number, BlockRef>;
  newIndexMap: Map<number, BlockRef>;
}

function getDiffHighlightWorker(): Worker | null {
  try {
    return getWorker();
  } catch {
    return null;
  }
}

function mapWorkerBlocks(response: TokenizeResponse): Map<string, TokenSpan[][]> {
  const byBlock = new Map<string, TokenSpan[][]>();
  for (const result of response.results) {
    if (!result.error && result.lines.length > 0) byBlock.set(result.blockId, result.lines);
  }
  return byBlock;
}

function addTokensFromBlock(
  target: Map<number, TokenSpan[]>,
  indexMap: ReadonlyMap<number, BlockRef>,
  byBlock: ReadonlyMap<string, TokenSpan[][]>,
  include: (index: number) => boolean,
): void {
  for (const [diffIndex, ref] of indexMap) {
    if (!include(diffIndex)) continue;
    const tokens = byBlock.get(ref.blockId)?.[ref.lineIdx];
    if (tokens) target.set(diffIndex, tokens);
  }
}

function createTokenMap(
  response: TokenizeResponse,
  blocks: DiffHighlightBlocks,
  lines: readonly ParsedDiffLine[],
): Map<number, TokenSpan[]> {
  const result = new Map<number, TokenSpan[]>();
  const byBlock = mapWorkerBlocks(response);
  addTokensFromBlock(result, blocks.newIndexMap, byBlock, () => true);
  addTokensFromBlock(
    result,
    blocks.oldIndexMap,
    byBlock,
    (index) => lines[index]?.type === "remove",
  );
  return result;
}

function requestDiffTokens({
  blocks,
  language,
  theme,
  lines,
  currentRequestId,
  setTokenMap,
}: {
  blocks: DiffHighlightBlocks;
  language: string;
  theme: ShikiTheme;
  lines: readonly ParsedDiffLine[];
  currentRequestId: { current: string | null };
  setTokenMap: (tokenMap: Map<number, TokenSpan[]>) => void;
}): (() => void) | undefined {
  const worker = getDiffHighlightWorker();
  if (!worker) return undefined;
  const id = nextRequestId("diff-hl");
  const generationAtRequest = workerGeneration;
  currentRequestId.current = id;
  pending.set(id, (response) => {
    if (currentRequestId.current !== id || workerGeneration !== generationAtRequest) return;
    const parsed = response as TokenizeResponse | null;
    if (!parsed || parsed.type !== "tokenize") return;
    setTokenMap(createTokenMap(parsed, blocks, lines));
  });
  worker.postMessage({
    id,
    type: "tokenize",
    blocks: blocks.blocks.map((block) => ({ ...block, language, theme })),
  });
  return () => {
    pending.delete(id);
    currentRequestId.current = null;
  };
}

/**
 * Two-pass syntax highlighting for diff lines using the Shiki Web Worker.
 *
 * For each hunk it assembles an "old" fragment (context + removed lines) and a
 * "new" fragment (context + added lines). Each fragment is a coherent,
 * contiguous slice of the file, so Shiki gets accurate cross-line state.
 *
 * Crucially, hunks are tokenized as separate blocks rather than glued into one
 * old/new block. Gluing non-contiguous hunks lets a multi-line construct opened
 * in one hunk (an unterminated block comment, template literal, etc.) bleed past
 * the hidden gap and mis-tokenize every following line as plain comment/string
 * text. Per-hunk blocks contain that state. All blocks ride a single worker
 * message to minimise round trips.
 *
 * @returns `getLineTokens(i)` - returns the token array for diff line `i`, or
 *   `null` while highlighting is pending (callers should fall back to plain text).
 */
export function useDiffHighlighter(
  lines: ParsedDiffLine[],
  language: string,
  theme: ShikiTheme,
  enabled: boolean = true,
): { getLineTokens: (index: number) => TokenSpan[] | null } {
  const [result, setResult] = useState<{ key: string; tokenMap: Map<number, TokenSpan[]> } | null>(null);
  const currentRequestId = useRef<string | null>(null);

  // Segment the diff into per-hunk old/new fragments in one pass, recording for
  // each diff line which block and block-line its tokens will come from.
  const diffBlocks = useMemo<DiffHighlightBlocks>(() => {
    const built: Array<{ blockId: string; code: string }> = [];
    const oldIdxMap = new Map<number, BlockRef>();
    const newIdxMap = new Map<number, BlockRef>();

    let hunk = 0;
    let oldLines: string[] = [];
    let newLines: string[] = [];

    // Emit the accumulated hunk fragments as blocks and advance the hunk index.
    const flush = () => {
      if (oldLines.length === 0 && newLines.length === 0) return;
      if (oldLines.length > 0) built.push({ blockId: `old:${hunk}`, code: oldLines.join("\n") });
      if (newLines.length > 0) built.push({ blockId: `new:${hunk}`, code: newLines.join("\n") });
      oldLines = [];
      newLines = [];
      hunk++;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.type === "header") {
        // A hunk header (`@@`) breaks contiguity: close the current fragment so
        // the next hunk tokenizes from a clean grammar state.
        if (line.content.startsWith("@@")) flush();
        continue;
      }
      if (line.type === "context") {
        oldIdxMap.set(i, { blockId: `old:${hunk}`, lineIdx: oldLines.length });
        newIdxMap.set(i, { blockId: `new:${hunk}`, lineIdx: newLines.length });
        oldLines.push(line.content);
        newLines.push(line.content);
      } else if (line.type === "remove") {
        oldIdxMap.set(i, { blockId: `old:${hunk}`, lineIdx: oldLines.length });
        oldLines.push(line.content);
      } else if (line.type === "add") {
        newIdxMap.set(i, { blockId: `new:${hunk}`, lineIdx: newLines.length });
        newLines.push(line.content);
      }
    }
    flush();

    return { blocks: built, oldIndexMap: oldIdxMap, newIndexMap: newIdxMap };
  }, [lines]);

  // Stable, value-based key for the effect deps so re-renders that produce an
  // equivalent block set don't re-issue a worker request.
  const blocksSignature = useMemo(
    () => diffBlocks.blocks.map((block) => `${block.blockId} ${block.code}`).join(""),
    [diffBlocks],
  );
  const requestKey = enabled && language !== "text" && diffBlocks.blocks.length > 0
    ? `${blocksSignature}\0${language}\0${theme}`
    : null;
  const setTokenMap = useCallback((tokenMap: Map<number, TokenSpan[]>) => {
    if (requestKey) setResult({ key: requestKey, tokenMap });
  }, [requestKey]);

  useEffect(() => {
    if (!requestKey) return;

    return requestDiffTokens({
      blocks: diffBlocks,
      language,
      theme,
      lines,
      currentRequestId,
      setTokenMap,
    });
  }, [diffBlocks, language, lines, requestKey, setTokenMap, theme]);

  const getLineTokens = useCallback(
    (index: number) => result?.key === requestKey
      ? result.tokenMap.get(index) ?? null
      : null,
    [requestKey, result],
  );

  return { getLineTokens };
}

export type { TokenSpan };
