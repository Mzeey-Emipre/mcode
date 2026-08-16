import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockDeleteThread } = vi.hoisted(() => ({
  mockDeleteThread: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/transport", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/transport")>();
  return {
    ...original,
    getTransport: () => ({
      deleteThread: mockDeleteThread,
    }),
  };
});

import { useWorkspaceStore } from "../workspaceStore";
import type { Thread } from "@/transport";

const baseThread = {
  id: "t1",
  workspace_id: "ws1",
  branch: "feat/my-feature",
  mode: "worktree",
  worktree_path: "/path/to/worktree",
  status: "active",
  pr_number: null,
  pr_status: null,
} as unknown as Thread;

describe("workspaceStore.recordPrCreated", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      threads: [baseThread],
      prUrlsByThreadId: {},
    });
  });

  it("sets pr_number and pr_status on the matching thread", () => {
    useWorkspaceStore.getState().recordPrCreated("t1", 42, "https://github.com/o/r/pull/42");

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t1");
    expect(thread?.pr_number).toBe(42);
    expect(thread?.pr_status).toBe("OPEN");
  });

  it("stores the pr url in prUrlsByThreadId keyed by thread id", () => {
    useWorkspaceStore.getState().recordPrCreated("t1", 42, "https://github.com/o/r/pull/42");

    expect(useWorkspaceStore.getState().prUrlsByThreadId["t1"]).toBe(
      "https://github.com/o/r/pull/42",
    );
  });

  it("leaves other threads unchanged", () => {
    const other: Thread = { ...baseThread, id: "t2", pr_number: null };
    useWorkspaceStore.setState({ threads: [baseThread, other] });

    useWorkspaceStore.getState().recordPrCreated("t1", 42, "https://github.com/o/r/pull/42");

    const unchanged = useWorkspaceStore.getState().threads.find((t) => t.id === "t2");
    expect(unchanged?.pr_number).toBeNull();
  });

  it("is a no-op when the thread id is not found", () => {
    useWorkspaceStore.getState().recordPrCreated("not-exist", 1, "https://github.com/o/r/pull/1");

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t1");
    expect(thread?.pr_number).toBeNull();
    expect(useWorkspaceStore.getState().prUrlsByThreadId["not-exist"]).toBeUndefined();
  });
});

describe("workspaceStore.recordPullRequestLink", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      threads: [],
      prUrlsByThreadId: {},
    });
  });

  it("records the URL before the linked Review task is loaded", () => {
    useWorkspaceStore.getState().recordPullRequestLink(
      "review-thread",
      42,
      "https://github.com/o/r/pull/42",
      "open",
    );

    expect(useWorkspaceStore.getState().prUrlsByThreadId["review-thread"]).toBe(
      "https://github.com/o/r/pull/42",
    );
    expect(useWorkspaceStore.getState().threads).toEqual([]);
  });

  it("updates an already loaded thread with the remote PR state", () => {
    useWorkspaceStore.setState({ threads: [baseThread] });

    useWorkspaceStore.getState().recordPullRequestLink(
      "t1",
      42,
      "https://github.com/o/r/pull/42",
      "merged",
    );

    expect(useWorkspaceStore.getState().threads[0]).toMatchObject({
      pr_number: 42,
      pr_status: "merged",
    });
  });
});

describe("workspaceStore.deleteThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      threads: [baseThread],
      prUrlsByThreadId: { t1: "https://github.com/o/r/pull/42" },
      activeThreadId: null,
      error: null,
    });
  });

  it("removes the thread's pr url from prUrlsByThreadId", async () => {
    await useWorkspaceStore.getState().deleteThread("t1", false);

    expect(useWorkspaceStore.getState().prUrlsByThreadId["t1"]).toBeUndefined();
  });
});
