import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiffRow } from "@/features/pull-requests/lib/pull-request-diff-row-model";

const workerMock = vi.hoisted(() => {
  const postMessage = vi.fn();
  return {
    postMessage,
    worker: { postMessage } as unknown as Worker,
    pending: new Map<string, (response: unknown) => void>(),
    nextId: 0,
  };
});

vi.mock("@/lib/shiki-worker-client", () => ({
  getWorker: () => workerMock.worker,
  workerGeneration: 0,
  pending: workerMock.pending,
  nextRequestId: (prefix: string) => `${prefix}-${workerMock.nextId++}`,
}));

import {
  buildPullRequestHighlightWindow,
  usePullRequestDiffHighlighter,
} from "../usePullRequestDiffHighlighter";

function lineRow(index: number, path = "src/a.ts", hunkIndex = 0): PullRequestDiffRow {
  return {
    kind: "line",
    key: `pr-l:test:${hunkIndex}:${index}`,
    path,
    hunkIndex,
    leftType: "context",
    leftContent: `const old${index} = ${index};`,
    leftLineNumber: index + 1,
    rightType: "context",
    rightContent: `const next${index} = ${index};`,
    rightLineNumber: index + 1,
  };
}

describe("usePullRequestDiffHighlighter", () => {
  beforeEach(() => {
    workerMock.postMessage.mockReset();
    workerMock.pending.clear();
    workerMock.nextId = 0;
  });

  it("builds worker blocks only for the visible window and its bounded context", () => {
    const rows = Array.from({ length: 100 }, (_, index) => lineRow(index));
    const blocks = buildPullRequestHighlightWindow(
      rows,
      { startIndex: 40, endIndex: 44 },
      "github-dark",
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0].lineKeys).toHaveLength(21);
    expect(blocks[0].lineKeys[0]).toBe("pr-c:test:0:32:left:context");
    expect(blocks[0].lineKeys.at(-1)).toBe("pr-c:test:0:52:left:context");
  });

  it("cancels stale jobs and applies only the latest response", () => {
    const firstRows = [lineRow(1)];
    const secondRows = [lineRow(2)];
    const { result, rerender } = renderHook(
      ({ rows }) =>
        usePullRequestDiffHighlighter(
          rows,
          { startIndex: 0, endIndex: 0 },
          "github-dark",
        ),
      { initialProps: { rows: firstRows } },
    );
    const firstRequest = workerMock.postMessage.mock.calls[0][0];

    rerender({ rows: secondRows });
    expect(workerMock.postMessage).toHaveBeenCalledWith({
      type: "cancel",
      id: firstRequest.id,
    });
    const secondRequest = workerMock.postMessage.mock.calls.find(
      ([message]) => message.type === "tokenize-diff-window" && message.id !== firstRequest.id,
    )?.[0];
    expect(secondRequest).toBeDefined();

    act(() => {
      workerMock.pending.get(firstRequest.id)?.({
        id: firstRequest.id,
        type: "tokenize-diff-window",
        results: [],
        tokenBytes: 0,
      });
      workerMock.pending.get(secondRequest.id)?.({
        id: secondRequest.id,
        type: "tokenize-diff-window",
        tokenBytes: 64,
        results: secondRequest.blocks.map((block: { blockId: string; lineKeys: string[] }) => ({
          blockId: block.blockId,
          lineKeys: block.lineKeys,
          lines: block.lineKeys.map((key: string) => [{ content: key, color: "#fff" }]),
          truncatedLineKeys: [],
          tokenBytes: 32,
        })),
      });
    });

    expect(result.current.getLineTokens("pr-c:test:0:2:right:context")?.[0]?.content).toBe(
      "pr-c:test:0:2:right:context",
    );
    expect(result.current.getLineTokens("pr-c:test:0:1:right:context")).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("drops tokens when the parent patch cache rejects their byte cost", () => {
    const report = vi.fn(() => false);
    const { result } = renderHook(() =>
      usePullRequestDiffHighlighter(
        [lineRow(1)],
        { startIndex: 0, endIndex: 0 },
        "github-dark",
        { onTokenBytesChange: report },
      ),
    );
    const request = workerMock.postMessage.mock.calls[0][0];
    act(() => {
      workerMock.pending.get(request.id)?.({
        id: request.id,
        type: "tokenize-diff-window",
        tokenBytes: 64,
        results: request.blocks.map((block: { blockId: string; lineKeys: string[] }) => ({
          blockId: block.blockId,
          lineKeys: block.lineKeys,
          lines: block.lineKeys.map(() => [{ content: "token", color: "#fff" }]),
          truncatedLineKeys: [],
          tokenBytes: 32,
        })),
      });
    });

    expect(report).toHaveBeenCalledWith("src/a.ts", 64);
    expect(result.current.tokenBytes).toBe(0);
    expect(result.current.getLineTokens("pr-c:test:0:1:right:context")).toBeNull();
  });
});
