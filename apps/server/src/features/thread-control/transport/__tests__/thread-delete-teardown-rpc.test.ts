import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";

function threadDeleteRequest(threadId: string, cleanupWorktree = false): string {
  return JSON.stringify({
    id: "delete-1",
    method: "thread.delete",
    params: { threadId, cleanupWorktree },
  });
}

function workspaceRequest(method: "workspace.delete" | "workspace.forceDelete"): string {
  return JSON.stringify({
    id: "workspace-delete-1",
    method,
    params: { id: "workspace-1" },
  });
}

function threadDeps() {
  const deleteThread = vi.fn().mockReturnValue(true);
  const deps = {
    threadService: { delete: deleteThread },
  } as unknown as RouterDeps;
  return { deps, deleteThread };
}

function workspaceDeps() {
  const teardownThread = vi.fn().mockResolvedValue(undefined);
  const deleteWorkspace = vi.fn().mockReturnValue(true);
  const forceDeleteWorkspace = vi.fn().mockReturnValue(true);
  const beginWorkspaceTeardown = vi.fn().mockResolvedValue(() => undefined);
  const listAllByWorkspace = vi.fn().mockReturnValue([
    { id: "t-1", worktree_path: "C:/repo-worktree-1" },
    { id: "t-2", worktree_path: "C:/repo-worktree-2" },
  ]);
  const deps = {
    gitWatcherService: { unwatchWorkspace: vi.fn() },
    threadRepo: {
      listAllByWorkspace,
    },
    threadDeletionTeardownService: { teardownThread },
    projectActionService: {
      beginWorkspaceTeardown,
    },
    workspaceService: {
      delete: deleteWorkspace,
      forceDelete: forceDeleteWorkspace,
    },
    workspaceEnvironmentService: {
      beginWorkspaceDeletion: vi.fn(() => () => undefined),
      cancelSetupForWorkspace: vi.fn().mockResolvedValue(undefined),
      clearApprovals: vi.fn(),
    },
  } as unknown as RouterDeps;
  return {
    deps,
    teardownThread,
    deleteWorkspace,
    forceDeleteWorkspace,
    beginWorkspaceTeardown,
    listAllByWorkspace,
  };
}

describe("thread.delete", () => {
  it("delegates deletion to the lifecycle service", async () => {
    const { deps, deleteThread } = threadDeps();

    const response = await routeMessage(threadDeleteRequest("t-delete"), deps);

    expect(response).toEqual({ id: "delete-1", result: true });
    expect(deleteThread).toHaveBeenCalledWith("t-delete", false);
  });

  it("returns a lifecycle deletion failure", async () => {
    const { deps, deleteThread } = threadDeps();
    deleteThread.mockRejectedValue(new Error("PTY refused to exit"));

    const response = await routeMessage(threadDeleteRequest("t-delete"), deps);

    expect(response).toMatchObject({
      id: "delete-1",
      error: { code: "INTERNAL_ERROR", message: "PTY refused to exit" },
    });
    expect(deleteThread).toHaveBeenCalledExactlyOnceWith("t-delete", false);
  });
});

describe("workspace delete teardown", () => {
  it("tears down child threads before soft-deleting the workspace", async () => {
    const {
      deps,
      teardownThread,
      deleteWorkspace,
      beginWorkspaceTeardown,
      listAllByWorkspace,
    } = workspaceDeps();
    const calls: string[] = [];
    teardownThread.mockImplementation(async (threadId: string) => {
      calls.push(`teardown:${threadId}`);
    });
    deleteWorkspace.mockImplementation(() => {
      calls.push("delete");
      return true;
    });

    const response = await routeMessage(workspaceRequest("workspace.delete"), deps);

    expect(response).toEqual({ id: "workspace-delete-1", result: true });
    expect(listAllByWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(beginWorkspaceTeardown).toHaveBeenCalledWith("workspace-1");
    expect(teardownThread).toHaveBeenCalledWith("t-1");
    expect(teardownThread).toHaveBeenCalledWith("t-2");
    expect(calls).toEqual([
      "teardown:t-1",
      "teardown:t-2",
      "delete",
    ]);
  });

  it("does not hide the workspace when child thread teardown fails", async () => {
    const { deps, teardownThread, deleteWorkspace } = workspaceDeps();
    teardownThread.mockRejectedValueOnce(new Error("agent still running"));

    const response = await routeMessage(workspaceRequest("workspace.delete"), deps);

    expect(response).toMatchObject({
      id: "workspace-delete-1",
      error: {
        code: "INTERNAL_ERROR",
        message: "Workspace teardown failed for workspace-1: agent still running",
      },
    });
    expect(deleteWorkspace).not.toHaveBeenCalled();
  });

  it("tears down child threads before force-deleting the workspace", async () => {
    const { deps, teardownThread, forceDeleteWorkspace } = workspaceDeps();

    const response = await routeMessage(workspaceRequest("workspace.forceDelete"), deps);

    expect(response).toEqual({ id: "workspace-delete-1", result: true });
    expect(teardownThread).toHaveBeenCalledTimes(2);
    expect(forceDeleteWorkspace).toHaveBeenCalledWith("workspace-1");
  });
});
