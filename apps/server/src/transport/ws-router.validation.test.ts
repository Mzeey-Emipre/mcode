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
  it("resolves the git path from a workspace thread before creating the branch", async () => {
    const createBranch = vi.fn().mockResolvedValue("feat/from-thread");
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
        updateCheckoutToNamedBranch: vi.fn().mockReturnValue({
          id: "thread-1",
          branch: "feat/from-thread",
          checkout_state: "named",
        }),
      },
      gitService: {
        createBranch,
        resolveWorkingDir,
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
    expect(resolveWorkingDir).toHaveBeenCalledWith(
      "C:/repo",
      "worktree",
      "C:/repo-worktree",
    );
    expect(createBranch).toHaveBeenCalledWith("C:/repo-worktree", "feat/from-thread");
    expect(deps.threadRepo.updateCheckoutToNamedBranch).toHaveBeenCalledWith(
      "thread-1",
      "feat/from-thread",
    );
  });

  it("returns an error when the new branch cannot be attached to the thread", async () => {
    const createBranch = vi.fn().mockResolvedValue("feat/from-thread");
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
        updateCheckoutToNamedBranch: vi.fn().mockReturnValue(null),
      },
      gitService: {
        createBranch,
        resolveWorkingDir: vi.fn().mockReturnValue("C:/repo-worktree"),
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
    expect(createBranch).toHaveBeenCalledWith("C:/repo-worktree", "feat/from-thread");
  });

  it("rejects a thread from another workspace before creating a branch", async () => {
    const createBranch = vi.fn();
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
        createBranch,
        resolveWorkingDir: vi.fn(),
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
    expect(createBranch).not.toHaveBeenCalled();
  });

  it("rejects invalid branch names before dispatch", async () => {
    const createBranch = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "C:/repo" }),
      },
      gitService: {
        createBranch,
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
    expect(createBranch).not.toHaveBeenCalled();
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
