import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import { _resetForTest, addClient } from "./push.js";
import {
  RECAP_MAX_MESSAGE_CONTENT_CHARS,
  RECAP_MAX_MESSAGES,
  RECAP_MAX_PREVIOUS_RECAP_CHARS,
} from "@mcode/contracts";
import {
  resetTransportPayloadValidatorForTest,
  setTransportPayloadValidatorForTest,
  type TransportPayloadValidator,
} from "./payload-validation.js";

function fakeOpenSocket(received: Array<{ buf: Buffer; binary: boolean }>): WebSocket {
  const ws: Partial<WebSocket> = {
    readyState: 1,
    OPEN: 1,
    send: ((data: unknown, opts?: { binary?: boolean }) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as Uint8Array);
      received.push({ buf, binary: !!opts?.binary });
    }) as WebSocket["send"],
  };
  return ws as WebSocket;
}

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

describe("routeMessage recap.generate", () => {
  it("delegates valid caller-supplied recap material without resolving thread state", async () => {
    const generate = vi.fn().mockResolvedValue({ text: "Implementing recap.generate." });
    const deps = {
      recapService: { generate },
      threadRepo: { findById: vi.fn() },
      workspaceRepo: { findById: vi.fn() },
      messageRepo: { listByThread: vi.fn() },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-recap",
        method: "recap.generate",
        params: {
          threadId: "thread-1",
          messages: [
            { role: "user", content: "Build recap.generate." },
            { role: "assistant", content: "Adding the RPC and tests." },
          ],
          previousRecap: null,
        },
      }),
      deps,
    );

    expect(response.result).toEqual({ text: "Implementing recap.generate." });
    expect(generate).toHaveBeenCalledWith({
      threadId: "thread-1",
      messages: [
        { role: "user", content: "Build recap.generate." },
        { role: "assistant", content: "Adding the RPC and tests." },
      ],
      previousRecap: null,
    });
    expect(deps.threadRepo.findById).not.toHaveBeenCalled();
    expect(deps.workspaceRepo.findById).not.toHaveBeenCalled();
    expect(deps.messageRepo.listByThread).not.toHaveBeenCalled();
  });

  it("rejects invalid message roles before dispatch", async () => {
    const generate = vi.fn();
    const deps = {
      recapService: { generate },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-recap-role",
        method: "recap.generate",
        params: {
          threadId: "thread-1",
          messages: [{ role: "system", content: "hidden context" }],
          previousRecap: null,
        },
      }),
      deps,
    );

    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects oversized recap payloads before prompt assembly", async () => {
    const generate = vi.fn();
    const deps = {
      recapService: { generate },
    } as unknown as RouterDeps;

    const tooManyMessages = Array.from(
      { length: RECAP_MAX_MESSAGES + 1 },
      () => ({ role: "user", content: "hello" }),
    );

    for (const params of [
      {
        threadId: "thread-1",
        messages: [{ role: "user", content: "x".repeat(RECAP_MAX_MESSAGE_CONTENT_CHARS + 1) }],
        previousRecap: null,
      },
      {
        threadId: "thread-1",
        messages: tooManyMessages,
        previousRecap: null,
      },
      {
        threadId: "thread-1",
        messages: [{ role: "user", content: "hello" }],
        previousRecap: "x".repeat(RECAP_MAX_PREVIOUS_RECAP_CHARS + 1),
      },
    ]) {
      const response = await routeMessage(
        JSON.stringify({
          id: "req-recap-oversized",
          method: "recap.generate",
          params,
        }),
        deps,
      );

      expect(response.error?.code).toBe("INVALID_PARAMS");
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects omitted previousRecap before dispatch", async () => {
    const generate = vi.fn();
    const deps = {
      recapService: { generate },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-recap-previous-missing",
        method: "recap.generate",
        params: {
          threadId: "thread-1",
          messages: [{ role: "user", content: "Build recap.generate." }],
        },
      }),
      deps,
    );

    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("routeMessage git.createBranch", () => {
  afterEach(() => {
    _resetForTest();
  });

  it("delegates branch creation, then broadcasts the persisted checkout state", async () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(received));
    const createBranchForThread = vi.fn().mockResolvedValue("feat/from-thread");
    const findById = vi.fn().mockReturnValue({
      id: "thread-1",
      workspace_id: "ws-1",
      branch: "feat/from-thread",
      checkout_state: "named",
      base_branch: null,
      pr_number: null,
      pr_status: null,
    });
    const deps = {
      threadService: {
        createBranchForThread,
        findById,
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
    expect(findById).toHaveBeenCalledWith("thread-1");
    expect(JSON.parse(received[0].buf.toString("utf-8"))).toMatchObject({
      channel: "thread.checkoutChanged",
      data: {
        threadId: "thread-1",
        workspaceId: "ws-1",
        branch: "feat/from-thread",
        checkoutState: "named",
        baseBranch: null,
        prNumber: null,
        prStatus: null,
      },
    });
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

describe("routeMessage workspace.delete watcher teardown", () => {
  it("keeps thread worktree watchers when any workspace thread teardown fails", async () => {
    const unwatchThreadWorktree = vi.fn();
    const deleteWorkspace = vi.fn();
    const deps = {
      threadRepo: {
        listAllByWorkspace: vi.fn().mockReturnValue([
          { id: "thread-1", worktree_path: null },
          { id: "thread-2", worktree_path: null },
        ]),
      },
      githubService: {
        cancelForRepoPath: vi.fn().mockResolvedValue(undefined),
      },
      ciWatcherService: {
        teardownThread: vi.fn().mockResolvedValue(undefined),
      },
      threadTeardownService: {
        teardownThread: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("teardown failed")),
      },
      gitWatcherService: {
        unwatchThreadWorktree,
      },
      workspaceService: {
        delete: deleteWorkspace,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-workspace-delete",
        method: "workspace.delete",
        params: { id: "ws-1" },
      }),
      deps,
    );

    expect(response.error?.message).toContain("Workspace teardown failed for ws-1");
    expect(unwatchThreadWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspace).not.toHaveBeenCalled();
  });

  it("unwatches thread worktrees after all workspace thread teardowns succeed", async () => {
    const unwatchThreadWorktree = vi.fn();
    const teardownThread = vi.fn().mockResolvedValue(undefined);
    const deps = {
      threadRepo: {
        listAllByWorkspace: vi.fn().mockReturnValue([
          { id: "thread-1", worktree_path: null },
          { id: "thread-2", worktree_path: null },
        ]),
      },
      githubService: {
        cancelForRepoPath: vi.fn().mockResolvedValue(undefined),
      },
      ciWatcherService: {
        teardownThread: vi.fn().mockResolvedValue(undefined),
      },
      threadTeardownService: {
        teardownThread,
      },
      gitWatcherService: {
        unwatchThreadWorktree,
        unwatchWorkspace: vi.fn(),
      },
      workspaceService: {
        delete: vi.fn().mockReturnValue(true),
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-workspace-delete",
        method: "workspace.delete",
        params: { id: "ws-1" },
      }),
      deps,
    );

    expect(response.result).toBe(true);
    expect(unwatchThreadWorktree).toHaveBeenCalledWith("thread-1");
    expect(unwatchThreadWorktree).toHaveBeenCalledWith("thread-2");
    expect(teardownThread.mock.invocationCallOrder[1]).toBeLessThan(
      unwatchThreadWorktree.mock.invocationCallOrder[0],
    );
  });
});

describe("routeMessage thread.delete watcher teardown", () => {
  function createThreadDeleteDeps(options: {
    teardown?: () => Promise<void>;
    deleteThread?: () => Promise<boolean>;
  } = {}) {
    const unwatchThreadWorktree = vi.fn();
    const teardownThread = vi
      .fn()
      .mockImplementation(options.teardown ?? (() => Promise.resolve()));
    const deleteThread = vi
      .fn()
      .mockImplementation(options.deleteThread ?? (() => Promise.resolve(true)));
    const deps = {
      ciWatcherService: {
        teardownThread: vi.fn().mockResolvedValue(undefined),
      },
      githubService: {
        cancelForRepoPath: vi.fn().mockResolvedValue(undefined),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitWatcherService: {
        unwatchThreadWorktree,
      },
      threadTeardownService: {
        teardownThread,
      },
      threadService: {
        delete: deleteThread,
      },
    } as unknown as RouterDeps;
    return { deps, unwatchThreadWorktree, teardownThread, deleteThread };
  }

  it("keeps the thread worktree watcher when thread teardown fails", async () => {
    const { deps, unwatchThreadWorktree, deleteThread } = createThreadDeleteDeps({
      teardown: () => Promise.reject(new Error("teardown failed")),
    });

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-delete",
        method: "thread.delete",
        params: { threadId: "thread-1", cleanupWorktree: true },
      }),
      deps,
    );

    expect(response.error?.message).toContain("teardown failed");
    expect(unwatchThreadWorktree).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  it("keeps the thread worktree watcher when thread delete returns false", async () => {
    const { deps, unwatchThreadWorktree } = createThreadDeleteDeps({
      deleteThread: () => Promise.resolve(false),
    });

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-delete",
        method: "thread.delete",
        params: { threadId: "thread-1", cleanupWorktree: true },
      }),
      deps,
    );

    expect(response.result).toBe(false);
    expect(unwatchThreadWorktree).not.toHaveBeenCalled();
  });

  it("unwatches the thread worktree after thread teardown and delete succeed", async () => {
    const { deps, unwatchThreadWorktree, teardownThread, deleteThread } = createThreadDeleteDeps();

    const response = await routeMessage(
      JSON.stringify({
        id: "req-thread-delete",
        method: "thread.delete",
        params: { threadId: "thread-1", cleanupWorktree: true },
      }),
      deps,
    );

    expect(response.result).toBe(true);
    expect(unwatchThreadWorktree).toHaveBeenCalledWith("thread-1");
    expect(teardownThread.mock.invocationCallOrder[0]).toBeLessThan(
      unwatchThreadWorktree.mock.invocationCallOrder[0],
    );
    expect(deleteThread.mock.invocationCallOrder[0]).toBeLessThan(
      unwatchThreadWorktree.mock.invocationCallOrder[0],
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

  it("refreshes linked pull requests through one batch and stops terminal watchers", async () => {
    const checks = { aggregate: "passing" as const, runs: [], fetchedAt: 1 };
    const getPullRequestWatchSnapshots = vi.fn().mockResolvedValue([
      { threadId: "thread-1", prNumber: 41, state: "OPEN", checks },
      { threadId: "thread-2", prNumber: 42, state: "MERGED", checks },
    ]);
    const watch = vi.fn();
    const refresh = vi.fn();
    const unwatch = vi.fn();
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
            id: "thread-1",
            branch: "feat/one",
            mode: "worktree",
            checkout_state: "named",
            pr_number: 41,
            pr_status: "OPEN",
          },
          {
            id: "thread-2",
            branch: "feat/two",
            mode: "worktree",
            checkout_state: "named",
            pr_number: 42,
            pr_status: "OPEN",
          },
        ]),
        linkPr: vi.fn(),
      },
      githubService: {
        getPullRequestWatchSnapshots,
        getBranchPr: vi.fn(),
      },
      ciWatcherService: { watch, refresh, unwatch },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-sync-linked",
        method: "thread.syncPrs",
        params: { workspaceId: "ws-1" },
      }),
      deps,
    );

    expect(getPullRequestWatchSnapshots).toHaveBeenCalledTimes(1);
    expect(getPullRequestWatchSnapshots).toHaveBeenCalledWith([
      { threadId: "thread-1", prNumber: 41, repoPath: "C:/repo" },
      { threadId: "thread-2", prNumber: 42, repoPath: "C:/repo" },
    ]);
    expect(deps.githubService.getBranchPr).not.toHaveBeenCalled();
    expect(response.result).toEqual([
      { threadId: "thread-2", prNumber: 42, prStatus: "MERGED" },
    ]);
    expect(watch).toHaveBeenCalledWith(
      "thread-1",
      41,
      "feat/one",
      "C:/repo",
      { skipInitialFetch: true },
    );
    expect(refresh).toHaveBeenCalledWith("thread-1", checks);
    expect(unwatch).toHaveBeenCalledWith("thread-2");
  });
});

describe("routeMessage github.checkStatus", () => {
  it("does not bootstrap check polling for branchless worktree threads", async () => {
    const getCheckRuns = vi.fn();
    const watch = vi.fn();
    const deps = {
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "branchless-thread",
          workspace_id: "ws-1",
          branch: "main",
          mode: "worktree",
          checkout_state: "branchless",
          pr_number: 42,
          pr_status: "OPEN",
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
        }),
      },
      ciWatcherService: {
        getFreshCache: vi.fn().mockReturnValue(null),
        getEntry: vi.fn().mockReturnValue(null),
        watch,
        refresh: vi.fn(),
      },
      githubService: {
        getCheckRuns,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-checks",
        method: "github.checkStatus",
        params: { threadId: "branchless-thread" },
      }),
      deps,
    );

    expect(response.result).toMatchObject({ aggregate: "no_checks", runs: [] });
    expect(watch).not.toHaveBeenCalled();
    expect(getCheckRuns).not.toHaveBeenCalled();
  });

  it("bootstraps check polling only for named worktree threads", async () => {
    const getCheckRuns = vi.fn().mockResolvedValue({
      aggregate: "passing",
      runs: [],
      fetchedAt: 1,
    });
    const watch = vi.fn();
    const deps = {
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "named-thread",
          workspace_id: "ws-1",
          branch: "feat/named",
          mode: "worktree",
          checkout_state: "named",
          pr_number: 42,
          pr_status: "OPEN",
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          path: "C:/repo",
        }),
      },
      ciWatcherService: {
        getFreshCache: vi.fn().mockReturnValue(null),
        getEntry: vi
          .fn()
          .mockReturnValueOnce(null)
          .mockReturnValueOnce({
            branch: "feat/named",
            repoPath: "C:/repo",
          }),
        watch,
        refresh: vi.fn(),
      },
      githubService: {
        getCheckRuns,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-checks",
        method: "github.checkStatus",
        params: { threadId: "named-thread" },
      }),
      deps,
    );

    expect(response.result).toEqual({
      aggregate: "passing",
      runs: [],
      fetchedAt: 1,
    });
    expect(watch).toHaveBeenCalledWith(
      "named-thread",
      42,
      "feat/named",
      "C:/repo",
      { skipInitialFetch: true },
    );
    expect(getCheckRuns).toHaveBeenCalledWith("feat/named", "C:/repo");
  });
});
