import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { parseDiffLines } from "@/lib/diff-parser";
import type { TokenSpan } from "@/workers/shiki.worker";

// Shared mock state for the Shiki worker client. Hoisted so the vi.mock factory
// (which runs before imports) can close over the same references the test reads.
const mock = vi.hoisted(() => {
  const postMessage = vi.fn();
  return {
    postMessage,
    fakeWorker: { postMessage } as unknown as Worker,
    pending: new Map<string, (response: unknown) => void>(),
  };
});

vi.mock("@/lib/shiki-worker-client", () => ({
  getWorker: () => mock.fakeWorker,
  workerGeneration: 0,
  pending: mock.pending,
  nextRequestId: (prefix: string) => `${prefix}-test`,
}));

import { useDiffHighlighter } from "./useDiffHighlighter";

/** Shape of the message posted to the worker, narrowed for assertions. */
interface PostedTokenizeMessage {
  id: string;
  type: "tokenize";
  blocks: Array<{ blockId: string; code: string; language: string; theme: string }>;
}

/** Reads the most recent tokenize message posted to the mocked worker. */
function lastPostedMessage(): PostedTokenizeMessage {
  const calls = mock.postMessage.mock.calls;
  return calls[calls.length - 1][0] as PostedTokenizeMessage;
}

/**
 * Resolves the pending worker request with one synthetic token per code line.
 * Each token's content is `${blockId}#${lineIdx}` so tests can assert which
 * block a diff line's tokens were sourced from.
 */
function resolveWorkerEcho(): void {
  const msg = lastPostedMessage();
  const results = msg.blocks.map((b) => ({
    blockId: b.blockId,
    lines: b.code.split("\n").map((_, lineIdx) => [
      { content: `${b.blockId}#${lineIdx}`, color: "#abcdef" } satisfies TokenSpan,
    ]),
  }));
  act(() => {
    mock.pending.get(msg.id)?.({ id: msg.id, type: "tokenize", results });
  });
}

// Two non-contiguous hunks. The first contains context + an add; the second a
// remove, an add, and context. The hidden gap between line 3 and line 50 is the
// seam that the old single-block implementation glued over.
const TWO_HUNK_DIFF = [
  "@@ -1,2 +1,3 @@",
  " const header = 1;",
  "+const added1 = 2;",
  " const ctx1 = 3;",
  "@@ -50,2 +60,2 @@",
  "-const removed = 4;",
  "+const added2 = 5;",
  " const ctx2 = 6;",
].join("\n");

describe("useDiffHighlighter", () => {
  beforeEach(() => {
    mock.postMessage.mockReset();
    mock.pending.clear();
  });

  it("tokenizes each hunk as its own block so multi-line state cannot bleed across the hidden gap", () => {
    const lines = parseDiffLines(TWO_HUNK_DIFF);

    renderHook(() => useDiffHighlighter(lines, "typescript", "github-dark"));

    const { blocks } = lastPostedMessage();
    const blockIds = blocks.map((b) => b.blockId);

    // Per-hunk segmentation: old + new fragment for each of the two hunks.
    // The pre-fix implementation glued everything into exactly one "old" and
    // one "new" block, which is what let an unterminated comment in hunk 1
    // mis-tokenize all of hunk 2.
    expect(blockIds).toEqual(["old:0", "new:0", "old:1", "new:1"]);

    // No single block may contain content drawn from two different hunks.
    for (const b of blocks) {
      const hasHunk1 = b.code.includes("header") || b.code.includes("added1");
      const hasHunk2 =
        b.code.includes("removed") ||
        b.code.includes("added2") ||
        b.code.includes("ctx2");
      expect(hasHunk1 && hasHunk2).toBe(false);
    }
  });

  it("maps each diff line's tokens to its own hunk's block (no cross-hunk bleed)", () => {
    const lines = parseDiffLines(TWO_HUNK_DIFF);

    const { result } = renderHook(() =>
      useDiffHighlighter(lines, "typescript", "github-dark"),
    );

    // Before the worker responds, callers fall back to plain text.
    expect(result.current.getLineTokens(2)).toBeNull();

    resolveWorkerEcho();

    // Line indices follow parseDiffLines order:
    //   1 context, 2 add (hunk 1) | 5 remove, 6 add, 7 context (hunk 2).
    const tokenContent = (i: number) => result.current.getLineTokens(i)?.[0]?.content;

    // Hunk 1: context and add come from the new fragment of hunk 0.
    expect(tokenContent(1)).toBe("new:0#0");
    expect(tokenContent(2)).toBe("new:0#1");

    // Hunk 2 must source from hunk-1 blocks, never hunk-0 — the regression guard.
    expect(tokenContent(5)).toBe("old:1#0"); // removed line -> old fragment
    expect(tokenContent(6)).toBe("new:1#0"); // added line -> new fragment
    expect(tokenContent(7)).toBe("new:1#1"); // context line -> new fragment
  });

  it("does not call the worker for plain-text (unknown language) diffs", () => {
    const lines = parseDiffLines(TWO_HUNK_DIFF);

    renderHook(() => useDiffHighlighter(lines, "text", "github-dark"));

    expect(mock.postMessage).not.toHaveBeenCalled();
  });
});
