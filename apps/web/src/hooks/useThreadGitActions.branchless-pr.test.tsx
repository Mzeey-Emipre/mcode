import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport";

const { mockUseBranchPr, mockUseHasCommitsAhead, mockWorkspaceSelector } = vi.hoisted(() => ({
  mockUseBranchPr: vi.fn().mockReturnValue(null),
  mockUseHasCommitsAhead: vi.fn().mockReturnValue(null),
  mockWorkspaceSelector: vi.fn(),
}));

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: (...args: unknown[]) => mockUseBranchPr(...args),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: (...args: unknown[]) => mockUseHasCommitsAhead(...args),
}));

vi.mock("@/features/projects/state/workspaceStore", () => {
  const store = Object.assign(
    vi.fn((selector: (state: unknown) => unknown) => mockWorkspaceSelector(selector)),
    { setState: vi.fn(), getState: vi.fn() },
  );
  return { useWorkspaceStore: store };
});

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ setPendingPrefill: vi.fn() }),
  ),
}));

vi.mock("@/lib/open-url-in-preview", () => ({
  openGitHubUrl: vi.fn(),
}));

import { useThreadGitActions } from "./useThreadGitActions";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Test Thread",
    status: "active",
    mode: "worktree",
    worktree_path: "/repo/.worktrees/test",
    branch: "feat/test",
    checkout_state: "named",
    base_branch: null,
    worktree_managed: true,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    provider: "claude",
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    default_open_in_app: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    has_file_changes: false,
    ...overrides,
  };
}

describe("useThreadGitActions branchless PR gates", () => {
  beforeEach(() => {
    mockUseBranchPr.mockClear();
    mockUseHasCommitsAhead.mockClear();
    mockWorkspaceSelector.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        workspaces: [{ id: "ws-1", path: "/repo" }],
        prUrlsByThreadId: {},
        checksById: {},
        openPrs: [],
      }),
    );
  });

  it("does not poll PR or commits-ahead state while the worktree is branchless", () => {
    renderHook(() =>
      useThreadGitActions(
        makeThread({
          branch: "main",
          checkout_state: "branchless",
          base_branch: "main",
        }),
      ),
    );

    expect(mockUseBranchPr).toHaveBeenCalledWith(null, "/repo");
    expect(mockUseHasCommitsAhead).toHaveBeenCalledWith("", null, undefined);
  });

  it("activates polling after the thread has a named checkout", () => {
    renderHook(() =>
      useThreadGitActions(
        makeThread({
          branch: "feat/issue-801",
          checkout_state: "named",
          base_branch: null,
        }),
      ),
    );

    expect(mockUseBranchPr).toHaveBeenCalledWith("feat/issue-801", "/repo");
    expect(mockUseHasCommitsAhead).toHaveBeenCalledWith(
      "ws-1",
      "feat/issue-801",
      "thread-1",
    );
  });
});
