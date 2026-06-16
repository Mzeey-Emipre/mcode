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
  const [tokenMap, setTokenMap] = useState<Map<number, TokenSpan[]>>(new Map());
  const currentRequestId = useRef<string | null>(null);

  // Segment the diff into per-hunk old/new fragments in one pass, recording for
  // each diff line which block and block-line its tokens will come from.
  const { blocks, oldIndexMap, newIndexMap } = useMemo(() => {
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
    () => blocks.map((b) => `${b.blockId} ${b.code}`).join(""),
    [blocks],
  );

  useEffect(() => {
    if (!enabled || language === "text" || blocks.length === 0) {
      setTokenMap(new Map());
      return;
    }

    // Clear previous results so stale tokens don't show for a different file
    setTokenMap(new Map());

    let worker: Worker;
    try {
      worker = getWorker();
    } catch {
      return;
    }

    const id = nextRequestId("diff-hl");
    const generationAtRequest = workerGeneration;
    currentRequestId.current = id;

    pending.set(id, (response) => {
      if (
        currentRequestId.current !== id ||
        workerGeneration !== generationAtRequest
      ) {
        return;
      }

      const res = response as TokenizeResponse | null;
      if (!res || res.type !== "tokenize") return;

      // Index the per-hunk token lines by block id for O(1) lookup.
      const byBlock = new Map<string, TokenSpan[][]>();
      for (const result of res.results) {
        if (result.error || result.lines.length === 0) continue;
        byBlock.set(result.blockId, result.lines);
      }

      const map = new Map<number, TokenSpan[]>();

      // New fragments cover context + added lines.
      for (const [diffIdx, ref] of newIndexMap) {
        const tokens = byBlock.get(ref.blockId)?.[ref.lineIdx];
        if (tokens) map.set(diffIdx, tokens);
      }
      // Old fragments cover removed lines (context already came from the new
      // fragment above; removed lines exist only in the old fragment).
      for (const [diffIdx, ref] of oldIndexMap) {
        if (lines[diffIdx]?.type !== "remove") continue;
        const tokens = byBlock.get(ref.blockId)?.[ref.lineIdx];
        if (tokens) map.set(diffIdx, tokens);
      }

      setTokenMap(map);
    });

    worker.postMessage({
      id,
      type: "tokenize",
      blocks: blocks.map((b) => ({ blockId: b.blockId, code: b.code, language, theme })),
    });

    return () => {
      pending.delete(id);
      currentRequestId.current = null;
    };
    // blocks, oldIndexMap and newIndexMap all derive from the same memo as
    // blocksSignature, so the signature alone captures every block-related change.
  }, [blocksSignature, language, theme, enabled]);

  const getLineTokens = useCallback(
    (index: number) => tokenMap.get(index) ?? null,
    [tokenMap],
  );

  return { getLineTokens };
}

export type { TokenSpan };
