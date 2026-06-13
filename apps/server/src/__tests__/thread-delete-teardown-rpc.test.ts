import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "../transport/ws-router";

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

function threadDeps(): RouterDeps {
  return {
    ciWatcherService: { unwatch: vi.fn() },
    threadTeardownService: { teardownThread: vi.fn().mockResolvedValue(undefined) },
    threadService: { delete: vi.fn().mockReturnValue(true) },
  } as unknown as RouterDeps;
}

function workspaceDeps(): RouterDeps {
  return {
    gitWatcherService: { unwatchWorkspace: vi.fn() },
    threadRepo: {
      listAllByWorkspace: vi.fn().mockReturnValue([{ id: "t-1" }, { id: "t-2" }]),
    },
    threadTeardownService: { teardownThread: vi.fn().mockResolvedValue(undefined) },
    workspaceService: {
      delete: vi.fn().mockReturnValue(true),
      forceDelete: vi.fn().mockReturnValue(true),
    },
  } as unknown as RouterDeps;
}

describe("thread.delete teardown", () => {
  it("tears down runtime resources before deleting the thread row", async () => {
    const d = threadDeps();
    const calls: string[] = [];
    vi.mocked(d.ciWatcherService.unwatch).mockImplementation(() => {
      calls.push("ci");
    });
    vi.mocked(d.threadTeardownService.teardownThread).mockImplementation(async () => {
      calls.push("teardown");
    });
    vi.mocked(d.threadService.delete).mockImplementation(() => {
      calls.push("delete");
      return true;
    });

    const response = await routeMessage(threadDeleteRequest("t-delete"), d);

    expect(response).toEqual({ id: "delete-1", result: true });
    expect(d.threadTeardownService.teardownThread).toHaveBeenCalledWith("t-delete");
    expect(d.threadService.delete).toHaveBeenCalledWith("t-delete", false);
    expect(calls).toEqual(["ci", "teardown", "delete"]);
  });

  it("does not hide the thread when resource teardown fails", async () => {
    const d = threadDeps();
    vi.mocked(d.threadTeardownService.teardownThread).mockRejectedValue(
      new Error("PTY refused to exit"),
    );

    const response = await routeMessage(threadDeleteRequest("t-delete"), d);

    expect(response).toMatchObject({
      id: "delete-1",
      error: { code: "INTERNAL_ERROR", message: "PTY refused to exit" },
    });
    expect(d.threadService.delete).not.toHaveBeenCalled();
  });
});

describe("workspace delete teardown", () => {
  it("tears down child threads before soft-deleting the workspace", async () => {
    const d = workspaceDeps();
    const calls: string[] = [];
    vi.mocked(d.threadTeardownService.teardownThread).mockImplementation(async (threadId) => {
      calls.push(`teardown:${threadId}`);
    });
    vi.mocked(d.workspaceService.delete).mockImplementation(() => {
      calls.push("delete");
      return true;
    });

    const response = await routeMessage(workspaceRequest("workspace.delete"), d);

    expect(response).toEqual({ id: "workspace-delete-1", result: true });
    expect(d.threadRepo.listAllByWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(d.threadTeardownService.teardownThread).toHaveBeenCalledWith("t-1");
    expect(d.threadTeardownService.teardownThread).toHaveBeenCalledWith("t-2");
    expect(calls).toEqual(["teardown:t-1", "teardown:t-2", "delete"]);
  });

  it("does not hide the workspace when child thread teardown fails", async () => {
    const d = workspaceDeps();
    vi.mocked(d.threadTeardownService.teardownThread).mockRejectedValueOnce(
      new Error("agent still running"),
    );

    const response = await routeMessage(workspaceRequest("workspace.delete"), d);

    expect(response).toMatchObject({
      id: "workspace-delete-1",
      error: {
        code: "INTERNAL_ERROR",
        message: "Workspace teardown failed for workspace-1: agent still running",
      },
    });
    expect(d.workspaceService.delete).not.toHaveBeenCalled();
  });

  it("tears down child threads before force-deleting the workspace", async () => {
    const d = workspaceDeps();

    const response = await routeMessage(workspaceRequest("workspace.forceDelete"), d);

    expect(response).toEqual({ id: "workspace-delete-1", result: true });
    expect(d.threadTeardownService.teardownThread).toHaveBeenCalledTimes(2);
    expect(d.workspaceService.forceDelete).toHaveBeenCalledWith("workspace-1");
  });
});
