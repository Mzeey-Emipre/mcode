import { describe, expect, it, vi } from "vitest";
import type { ApprovalReviewMode, SelectedTextComment } from "@mcode/contracts";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { createDefaultComposerAgentSelection } from "../draft/composer-selection-state";
import type { ComposerExecutionTargetController } from "../execution/useComposerExecutionTarget";
import type { PreparedComposerSubmission } from "./composer-submission-types";

const workspaceActions = vi.hoisted(() => ({
  createAndSendMessage: vi.fn(),
  branchThread: vi.fn(),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => workspaceActions,
  },
}));

import { dispatchComposerTarget } from "./composer-submission-routes";

const comments: SelectedTextComment[] = [{
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
}];

const editor: SelectedTextCommentEditorDraft = {
  source: comments[0]!.source,
  note: "Unsaved addition.",
  mentions: [],
  escapeWarned: false,
  outsideWarned: false,
  anchor: "card",
};

function submission(
  content: string,
  selectedTextComments: SelectedTextComment[],
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft,
  approvalReviewMode: ApprovalReviewMode = "manual",
): PreparedComposerSubmission {
  return {
    snapshot: {
      revision: 1,
      rawInput: content,
      mentions: [],
      selectedTextComments,
      selectedTextCommentEditor,
      attachments: [],
      selection: { ...createDefaultComposerAgentSelection(), approvalReviewMode },
      goalPending: false,
    },
    prepared: { content, displayContent: content, browserCaptures: [] },
    trimmed: content.trim(),
    attachmentMetas: [],
  };
}

function execution(target: ComposerExecutionTargetController["target"]): ComposerExecutionTargetController {
  return {
    target,
    mode: target.mode,
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

describe("dispatchComposerTarget selected-text comments", () => {
  it("transfers a full new-thread draft to the optimistic placeholder", async () => {
    workspaceActions.createAndSendMessage.mockResolvedValue({ id: "thread-2" });
    const target = { kind: "new-thread" as const, mode: "direct" as const, branch: "main", branchSource: "branch" as const, hasWorktree: false };

    await dispatchComposerTarget({
      workspaceId: "workspace-1",
      target,
      execution: execution(target),
      submission: submission("", comments, editor, "automatic"),
    });

    expect(workspaceActions.createAndSendMessage).toHaveBeenCalledWith(
      "",
      expect.any(String),
      expect.anything(),
      undefined,
      expect.anything(),
      expect.any(String),
      expect.anything(),
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      [],
      undefined,
      undefined,
      expect.anything(),
      comments,
      expect.objectContaining({
        input: "",
        selectedTextComments: comments,
        selectedTextCommentEditor: editor,
        attachments: [],
      }),
      "automatic",
    );
  });

  it("transfers a branch draft with saved cards and an open editor", async () => {
    workspaceActions.branchThread.mockResolvedValue({ id: "thread-2" });
    const target = { kind: "branch" as const, mode: "direct" as const, branch: "main", worktreePath: null, worktreeIsDetached: false };

    await dispatchComposerTarget({
      threadId: "thread-1",
      branchFromMessageId: "message-1",
      target,
      execution: execution(target),
      submission: submission("Continue from this point.", comments, editor),
    });

    expect(workspaceActions.branchThread).toHaveBeenCalledWith(expect.objectContaining({
      content: "Continue from this point.",
      selectedTextComments: comments,
      composerDraft: expect.objectContaining({
        input: "Continue from this point.",
        selectedTextComments: comments,
        selectedTextCommentEditor: editor,
      }),
    }));
  });
});
