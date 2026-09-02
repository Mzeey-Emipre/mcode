import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedTextComment } from "@mcode/contracts";
import type { ComposerExecutionTargetController } from "../execution/useComposerExecutionTarget";
import { useComposerFormController } from "../draft/useComposerFormController";

const routeMocks = vi.hoisted(() => ({
  dispatchComposerTarget: vi.fn(),
}));

vi.mock("./composer-submission-routes", () => ({
  dispatchComposerTarget: routeMocks.dispatchComposerTarget,
  isComposerTargetReady: () => true,
}));

import { useComposerSubmissionController } from "./useComposerSubmissionController";

const comment: SelectedTextComment = {
  id: "11111111-1111-4111-8111-111111111111",
  displayNumber: 1,
  source: {
    threadId: "thread-1",
    messageId: "message-1",
    sourceRole: "assistant",
    start: 0,
    end: 5,
    quote: "focus",
  },
  note: "Explain this choice.",
  mentions: [],
};

const target = {
  kind: "new-thread" as const,
  mode: "direct" as const,
  branch: "main",
  branchSource: "branch" as const,
  hasWorktree: false,
};

function execution(): ComposerExecutionTargetController {
  return {
    target,
    mode: "direct",
    modeOptions: [],
    isGitRepo: false,
    needsWorkspace: false,
    isStaleWorktree: false,
    selectedWorktree: null,
    newThreadBranch: "main",
    newThreadBranchSource: "branch",
    branchExecMode: "direct",
    branchTargetBranch: "main",
    branchWorktreePath: null,
    branchWorktreeIsDetached: false,
    fetchingBranch: false,
    detectedPullRequest: null,
    setMode: vi.fn(),
    setBranchMode: vi.fn(),
    dismissDetectedPullRequest: vi.fn(),
    resetDetectedPullRequest: vi.fn(),
    reviewDetectedPullRequest: vi.fn(async () => null),
    setNewThreadMode: vi.fn(),
    setNewThreadBranch: vi.fn(),
    setNewThreadBranchFromPullRequest: vi.fn(),
  };
}

function useHarness() {
  const form = useComposerFormController({
    isNewThread: true,
    workspaceId: "workspace-1",
  });
  const controller = useComposerSubmissionController({
    isNewThread: true,
    workspaceId: "workspace-1",
    isAgentRunning: false,
    isThreadScaffold: false,
    form,
    execution: execution(),
    queue: {
      editing: null,
      queueIfGenerating: () => false,
      discardEmptyEdit: () => false,
      finishEditing: vi.fn(),
      resolvePreviewAnnotations: (annotations) => annotations,
    },
  });
  return { form, controller };
}

describe("useComposerSubmissionController selected-text comments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches comment-only drafts and clears them while acknowledgement is pending", async () => {
    let acknowledge!: () => void;
    routeMocks.dispatchComposerTarget.mockReturnValueOnce(new Promise<void>((resolve) => {
      acknowledge = resolve;
    }));
    const { result } = renderHook(useHarness);

    act(() => {
      result.current.form.setSelectedTextComments([comment]);
    });
    await waitFor(() => expect(result.current.form.state.selectedTextComments).toEqual([comment]));
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalledWith(expect.objectContaining({
      submission: expect.objectContaining({
        snapshot: expect.objectContaining({ rawInput: "", selectedTextComments: [comment] }),
      }),
    })));
    expect(result.current.form.state.selectedTextComments).toEqual([]);

    await act(async () => {
      acknowledge();
    });
    await waitFor(() => expect(result.current.form.state.selectedTextComments).toEqual([]));
  });

  it("retains saved cards when the dispatch fails or is cancelled before acknowledgement", async () => {
    routeMocks.dispatchComposerTarget.mockRejectedValueOnce(new Error("Cancelled before acknowledgement"));
    const { result } = renderHook(useHarness);

    act(() => {
      result.current.form.setSelectedTextComments([comment]);
    });
    await waitFor(() => expect(result.current.form.state.selectedTextComments).toEqual([comment]));
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalled());
    expect(result.current.form.state.selectedTextComments).toEqual([comment]);
  });

  it("dispatches saved cards after a dirty editor completes its dismissal warning flow", async () => {
    const { result } = renderHook(useHarness);

    act(() => {
      result.current.form.setSelectedTextComments([comment], {
        source: comment.source,
        note: "Unsaved note",
        mentions: [],
        escapeWarned: false,
        outsideWarned: false,
        anchor: "card",
      });
    });
    await waitFor(() => expect(result.current.form.state.selectedTextCommentEditor).toBeDefined());
    expect(result.current.form.state.selectedTextComments).toEqual([comment]);
    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(result.current.form.state.selectedTextCommentEditor?.outsideWarned).toBe(true));
    expect(routeMocks.dispatchComposerTarget).not.toHaveBeenCalled();

    act(() => {
      void result.current.controller.submit();
    });

    await waitFor(() => expect(routeMocks.dispatchComposerTarget).toHaveBeenCalledWith(expect.objectContaining({
      submission: expect.objectContaining({
        snapshot: expect.objectContaining({
          selectedTextComments: [comment],
          selectedTextCommentEditor: undefined,
        }),
      }),
    })));
    expect(result.current.form.state.selectedTextCommentEditor).toBeUndefined();
  });
});
