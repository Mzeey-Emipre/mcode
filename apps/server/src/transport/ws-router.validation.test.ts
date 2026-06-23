import { afterEach, describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import {
  resetTransportPayloadValidatorForTest,
  setTransportPayloadValidatorForTest,
  type TransportPayloadValidator,
} from "./payload-validation.js";

describe("routeMessage result validation seam", () => {
  afterEach(() => {
    resetTransportPayloadValidatorForTest();
  });

  it("delegates RPC result validation to the configured adapter", async () => {
    const validateRpcResult = vi.fn();
    const validator: TransportPayloadValidator = {
      validatePush: (_channel, data) => ({ ok: true, data }),
      validateRpcResult,
    };
    setTransportPayloadValidatorForTest(validator);

    const response = await routeMessage(
      JSON.stringify({ id: "req-1", method: "app.version", params: {} }),
      {} as RouterDeps,
    );

    expect(response.id).toBe("req-1");
    expect(typeof response.result).toBe("string");
    expect(validateRpcResult).toHaveBeenCalledWith(
      "app.version",
      response.result,
      expect.anything(),
    );
  });
});

describe("routeMessage git.getRemoteUrl", () => {
  it("resolves the git path from a workspace thread before calling GitService", async () => {
    const getRemoteUrl = vi.fn().mockResolvedValue({
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      label: "Mzeey-Empire/mcode",
    });
    const resolveWorkingDir = vi.fn().mockReturnValue("C:/repo-worktree");
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "C:/repo" }),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          workspace_id: "ws-1",
          mode: "worktree",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitService: {
        getRemoteUrl,
        resolveWorkingDir,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-remote",
        method: "git.getRemoteUrl",
        params: { workspaceId: "ws-1", threadId: "thread-1" },
      }),
      deps,
    );

    expect(response.result).toEqual({
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      label: "Mzeey-Empire/mcode",
    });
    expect(resolveWorkingDir).toHaveBeenCalledWith(
      "C:/repo",
      "worktree",
      "C:/repo-worktree",
    );
    expect(getRemoteUrl).toHaveBeenCalledWith("C:/repo-worktree");
  });

  it("rejects a thread from another workspace before running git", async () => {
    const getRemoteUrl = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "C:/repo" }),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          workspace_id: "ws-2",
          mode: "worktree",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitService: {
        getRemoteUrl,
        resolveWorkingDir: vi.fn(),
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-remote",
        method: "git.getRemoteUrl",
        params: { workspaceId: "ws-1", threadId: "thread-1" },
      }),
      deps,
    );

    expect(response.error?.message).toContain(
      "Thread thread-1 does not belong to workspace ws-1",
    );
    expect(getRemoteUrl).not.toHaveBeenCalled();
  });
});

describe("routeMessage git.createBranch", () => {
  it("delegates branch creation and checkout-state persistence to ThreadService", async () => {
    const createBranchForThread = vi.fn().mockResolvedValue("feat/from-thread");
    const deps = {
      threadService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", threadId: "thread-1", name: "feat/from-thread" },
      }),
      deps,
    );

    expect(response.result).toEqual({ branch: "feat/from-thread" });
    expect(createBranchForThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "feat/from-thread",
    );
  });

  it("returns an error when the new branch cannot be attached to the thread", async () => {
    const createBranchForThread = vi
      .fn()
      .mockRejectedValue(new Error("Failed to update checkout state for thread thread-1"));
    const deps = {
      threadService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", threadId: "thread-1", name: "feat/from-thread" },
      }),
      deps,
    );

    expect(response.error?.message).toContain(
      "Failed to update checkout state for thread thread-1",
    );
    expect(createBranchForThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "feat/from-thread",
    );
  });

  it("surfaces service rejection before returning a branch", async () => {
    const createBranchForThread = vi
      .fn()
      .mockRejectedValue(new Error("Thread thread-1 does not belong to workspace ws-1"));
    const deps = {
      threadService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", threadId: "thread-1", name: "feat/from-thread" },
      }),
      deps,
    );

    expect(response.error?.message).toContain(
      "Thread thread-1 does not belong to workspace ws-1",
    );
    expect(createBranchForThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "feat/from-thread",
    );
  });

  it("rejects invalid branch names before dispatch", async () => {
    const createBranchForThread = vi.fn();
    const deps = {
      threadService: {
        createBranchForThread,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-create",
        method: "git.createBranch",
        params: { workspaceId: "ws-1", name: "bad;name" },
      }),
      deps,
    );

    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(createBranchForThread).not.toHaveBeenCalled();
  });
});

describe("routeMessage thread.create", () => {
  it("creates new worktree threads as branchless", async () => {
    const create = vi.fn().mockReturnValue({
      id: "thread-1",
      workspace_id: "ws-1",
      title: "New thread",
      status: "active",
      mode: "worktree",
      worktree_path: "C:/repo-worktree",
      branch: "main",
      checkout_state: "branchless",
      base_branch: "main",
      worktree_managed: true,
      issue_number: null,
      pr_number: null,
      pr_status: null,
      sdk_session_id: null,
      model: null,
      provider: "claude",
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
      deleted_at: null,
      last_context_tokens: null,
      context_window: null,
      reasoning_level: null,
      interaction_mode: null,
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
    });
    const deps = {
      threadService: { create },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-create",
        method: "thread.create",
        params: {
          workspaceId: "ws-1",
          title: "New thread",
          mode: "worktree",
          branch: "main",
        },
      }),
      deps,
    );

    expect(response.result).toMatchObject({
      id: "thread-1",
      checkout_state: "branchless",
      base_branch: "main",
    });
    expect(create).toHaveBeenCalledWith(
      "ws-1",
      "New thread",
      "worktree",
      "main",
      { branchless: true },
    );
  });
});

describe("routeMessage github.createPr", () => {
  const namedThread = {
    id: "thread-1",
    workspace_id: "ws-1",
    mode: "worktree",
    worktree_path: "C:/repo-worktree",
    branch: "feat/from-thread",
    checkout_state: "named",
  };

  function createGithubPrDeps(thread: typeof namedThread, currentBranch: string | null) {
    const push = vi.fn().mockResolvedValue(undefined);
    const createPr = vi.fn().mockResolvedValue({
      number: 42,
      url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    });
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
          is_git_repo: true,
        }),
      },
      threadService: {
        findById: vi.fn().mockReturnValue(thread),
        linkPr: vi.fn(),
      },
      gitService: {
        resolveWorkingDir: vi.fn().mockReturnValue("C:/repo-worktree"),
        getCurrentBranchAt: vi.fn().mockResolvedValue(currentBranch),
        push,
      },
      githubService: {
        createPr,
      },
      ciWatcherService: {
        unwatch: vi.fn(),
        watch: vi.fn(),
        scheduleBumpAfterPush: vi.fn(),
      },
    } as unknown as RouterDeps;
    return { deps, push, createPr };
  }

  const createPrRequest = {
    id: "req-pr",
    method: "github.createPr",
    params: {
      workspaceId: "ws-1",
      threadId: "thread-1",
      title: "Add branchless worktrees",
      body: "Body",
      baseBranch: "main",
      isDraft: false,
    },
  };

  it("rejects branchless worktree threads without pushing or creating a PR", async () => {
    const { deps, push, createPr } = createGithubPrDeps(
      {
        ...namedThread,
        branch: "main",
        checkout_state: "branchless",
      },
      "HEAD",
    );

    const response = await routeMessage(JSON.stringify(createPrRequest), deps);

    expect(response.error?.message).toContain(
      "must be a named worktree checkout before creating a PR",
    );
    expect(push).not.toHaveBeenCalled();
    expect(createPr).not.toHaveBeenCalled();
  });

  it("rejects mismatched current branch without pushing or creating a PR", async () => {
    const { deps, push, createPr } = createGithubPrDeps(namedThread, "feat/other");

    const response = await routeMessage(JSON.stringify(createPrRequest), deps);

    expect(response.error?.message).toContain(
      "checkout is on feat/other, expected feat/from-thread",
    );
    expect(push).not.toHaveBeenCalled();
    expect(createPr).not.toHaveBeenCalled();
  });

  it("pushes and creates a PR only when thread state and current branch match", async () => {
    const { deps, push, createPr } = createGithubPrDeps(namedThread, "feat/from-thread");

    const response = await routeMessage(JSON.stringify(createPrRequest), deps);

    expect(response.result).toEqual({
      number: 42,
      url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    });
    expect(push).toHaveBeenCalledWith("C:/repo-worktree", "feat/from-thread");
    expect(createPr).toHaveBeenCalledWith({
      cwd: "C:/repo-worktree",
      title: "Add branchless worktrees",
      body: "Body",
      baseBranch: "main",
      isDraft: false,
    });
    expect(deps.threadService.linkPr).toHaveBeenCalledWith("thread-1", 42, "OPEN");
  });
});

describe("routeMessage thread.syncPrs", () => {
  it("checks PRs only for named worktree checkouts", async () => {
    const getBranchPr = vi.fn().mockResolvedValue({
      number: 42,
      state: "open",
    });
    const watch = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
          is_git_repo: true,
        }),
      },
      threadService: {
        list: vi.fn().mockReturnValue([
          {
            id: "branchless-thread",
            branch: "main",
            mode: "worktree",
            checkout_state: "branchless",
            pr_number: null,
            pr_status: null,
          },
          {
            id: "named-thread",
            branch: "feat/named",
            mode: "worktree",
            checkout_state: "named",
            pr_number: null,
            pr_status: null,
          },
          {
            id: "direct-thread",
            branch: "main",
            mode: "direct",
            checkout_state: "named",
            pr_number: null,
            pr_status: null,
          },
        ]),
        linkPr: vi.fn(),
      },
      githubService: {
        getBranchPr,
      },
      ciWatcherService: {
        watch,
        unwatch: vi.fn(),
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-sync",
        method: "thread.syncPrs",
        params: { workspaceId: "ws-1" },
      }),
      deps,
    );

    expect(response.result).toEqual([
      { threadId: "named-thread", prNumber: 42, prStatus: "open" },
    ]);
    expect(getBranchPr).toHaveBeenCalledTimes(1);
    expect(getBranchPr).toHaveBeenCalledWith("feat/named", "C:/repo");
    expect(deps.threadService.linkPr).toHaveBeenCalledWith(
      "named-thread",
      42,
      "open",
    );
    expect(watch).toHaveBeenCalledWith("named-thread", 42, "feat/named", "C:/repo");
  });
});
