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

/**
 * Two-pass syntax highlighting for diff lines using the Shiki Web Worker.
 *
 * Assembles an "old" block (context + removed lines) and a "new" block
 * (context + added lines) so each block represents a coherent file state,
 * giving accurate cross-line token highlighting. Both blocks are sent in a
 * single worker message to minimise round trips.
 *
 * @returns `getLineTokens(i)` — returns the token array for diff line `i`, or
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

  // Build the two code blocks and their index maps in one pass over the diff lines.
  const { oldBlock, newBlock, oldIndexMap, newIndexMap } = useMemo(() => {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    // Maps diff line index → block line index
    const oldIdxMap = new Map<number, number>();
    const newIdxMap = new Map<number, number>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.type === "context") {
        oldIdxMap.set(i, oldLines.length);
        newIdxMap.set(i, newLines.length);
        oldLines.push(line.content);
        newLines.push(line.content);
      } else if (line.type === "remove") {
        oldIdxMap.set(i, oldLines.length);
        oldLines.push(line.content);
      } else if (line.type === "add") {
        newIdxMap.set(i, newLines.length);
        newLines.push(line.content);
      }
      // header lines get no entry in either map
    }

    return {
      oldBlock: oldLines.join("\n"),
      newBlock: newLines.join("\n"),
      oldIndexMap: oldIdxMap,
      newIndexMap: newIdxMap,
    };
  }, [lines]);

  useEffect(() => {
    if (!enabled || language === "text" || (oldBlock === "" && newBlock === "")) {
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

      const map = new Map<number, TokenSpan[]>();

      for (const result of res.results) {
        if (result.error || result.lines.length === 0) continue;

        if (result.blockId === "old") {
          // Map old-block token lines back to diff line indices
          for (const [diffIdx, blockIdx] of oldIndexMap) {
            const tokens = result.lines[blockIdx];
            if (tokens) {
              // For context lines, prefer the new-block result (applied later);
              // remove lines are only in old block so set them here unconditionally.
              const lineType = lines[diffIdx]?.type;
              if (lineType === "remove") {
                map.set(diffIdx, tokens);
              }
            }
          }
        } else if (result.blockId === "new") {
          // Map new-block token lines back to diff line indices
          for (const [diffIdx, blockIdx] of newIndexMap) {
            const tokens = result.lines[blockIdx];
            if (tokens) {
              map.set(diffIdx, tokens);
            }
          }
        }
      }

      setTokenMap(map);
    });

    worker.postMessage({
      id,
      type: "tokenize",
      blocks: [
        { blockId: "old", code: oldBlock, language, theme },
        { blockId: "new", code: newBlock, language, theme },
      ],
    });

    return () => {
      pending.delete(id);
      currentRequestId.current = null;
    };
  }, [oldBlock, newBlock, language, theme, enabled]);

  const getLineTokens = useCallback(
    (index: number) => tokenMap.get(index) ?? null,
    [tokenMap],
  );

  return { getLineTokens };
}

export type { TokenSpan };
