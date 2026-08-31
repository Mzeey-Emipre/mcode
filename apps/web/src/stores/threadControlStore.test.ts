import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadControlIdentity, ThreadControlProjection, ThreadControlReadResult } from "@mcode/contracts";
import {
  getThreadControlEntry,
  resetThreadControlStoreForTests,
  threadControlKey,
  useThreadControlStore,
} from "./threadControlStore";

const { readThreadControlMock } = vi.hoisted(() => ({
  readThreadControlMock: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ readThreadControl: readThreadControlMock }),
}));

const IDENTITY: ThreadControlIdentity = { workspaceId: "workspace:1", threadId: "thread:1" };

function projection(status: "running" | "completed", updatedAt = "2026-07-29T00:00:00.000Z"): ThreadControlProjection {
  return {
    identity: IDENTITY,
    thread: {
      ...IDENTITY,
      title: "Coordinator",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      state: { status },
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt,
    },
    messages: [],
    hasMoreMessages: false,
    relation: null,
    children: [],
    approvals: [],
  };
}

describe("thread control projection store", () => {
  beforeEach(() => {
    resetThreadControlStoreForTests();
    readThreadControlMock.mockReset();
  });

  it("uses an unambiguous identity key and rehydrates retained entries", async () => {
    const result: ThreadControlReadResult = { status: "found", projection: projection("running") };
    readThreadControlMock.mockResolvedValue(result);

    await useThreadControlStore.getState().load(IDENTITY);
    expect(threadControlKey(IDENTITY)).toBe(JSON.stringify(["workspace:1", "thread:1"]));

    await useThreadControlStore.getState().rehydrate();
    expect(readThreadControlMock).toHaveBeenCalledTimes(2);
    expect(getThreadControlEntry(IDENTITY)?.projection).toEqual(result.projection);
  });

  it("drops a stale callback after a projection is cleared and replaced", async () => {
    let resolveOld!: (result: ThreadControlReadResult) => void;
    const oldRequest = new Promise<ThreadControlReadResult>((resolve) => { resolveOld = resolve; });
    readThreadControlMock.mockReturnValueOnce(oldRequest).mockResolvedValueOnce({
      status: "found",
      projection: projection("completed"),
    });

    const pending = useThreadControlStore.getState().load(IDENTITY);
    useThreadControlStore.getState().clear(IDENTITY);
    await useThreadControlStore.getState().load(IDENTITY);
    resolveOld({ status: "found", projection: projection("running") });
    await pending;

    expect(getThreadControlEntry(IDENTITY)?.projection?.thread.state).toEqual({ status: "completed" });
  });

  it("queues a forced refresh when invalidation arrives during hydrate", async () => {
    let resolveOld!: (result: ThreadControlReadResult) => void;
    let resolveFresh!: (result: ThreadControlReadResult) => void;
    const oldRequest = new Promise<ThreadControlReadResult>((resolve) => { resolveOld = resolve; });
    const freshRequest = new Promise<ThreadControlReadResult>((resolve) => { resolveFresh = resolve; });
    readThreadControlMock.mockReturnValueOnce(oldRequest).mockReturnValueOnce(freshRequest);

    const firstLoad = useThreadControlStore.getState().load(IDENTITY);
    await Promise.resolve();
    await useThreadControlStore.getState().refreshByThreadId(IDENTITY.threadId, IDENTITY.workspaceId);
    resolveOld({ status: "found", projection: projection("running", "2026-07-29T00:00:00.000Z") });
    await Promise.resolve();
    expect(readThreadControlMock).toHaveBeenCalledTimes(2);
    resolveFresh({ status: "found", projection: projection("completed", "2026-07-29T00:01:00.000Z") });
    await Promise.all([firstLoad, Promise.resolve()]);

    expect(getThreadControlEntry(IDENTITY)?.projection?.thread).toMatchObject({
      state: { status: "completed" },
      updatedAt: "2026-07-29T00:01:00.000Z",
    });
  });

  it("runs a queued forced refresh after the active request fails", async () => {
    let rejectInitial!: (reason?: unknown) => void;
    const initialRequest = new Promise<ThreadControlReadResult>((_resolve, reject) => { rejectInitial = reject; });
    readThreadControlMock.mockReturnValueOnce(initialRequest).mockResolvedValueOnce({
      status: "found",
      projection: projection("completed", "2026-07-29T00:01:00.000Z"),
    });

    const initialLoad = useThreadControlStore.getState().load(IDENTITY);
    await Promise.resolve();
    await useThreadControlStore.getState().refreshByThreadId(IDENTITY.threadId, IDENTITY.workspaceId);
    rejectInitial(new Error("network unavailable"));
    await initialLoad;
    await Promise.resolve();

    expect(readThreadControlMock).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(getThreadControlEntry(IDENTITY)?.projection?.thread.state).toEqual({ status: "completed" });
  });
});
